#!/usr/bin/env python3
"""VariDub（综译）本地推理 sidecar —— SPEC-001 §7.4 / §7.5。

由 Electron 主进程以子进程方式拉起：

    python sidecar/server.py --port 0 --models-root <dir>

* 端口传 0 表示由系统分配，就绪后向 **stdout** 打印一行含 `"port": N` 的 JSON，
  主进程 `sidecar/manager.ts` 用正则 `/"port"\s*:\s*(\d+)/` 抓取并随后调 /health。
* 只监听 127.0.0.1，不接受外部连接。
* 契约（与 src/main/sidecar/client.ts 一一对应）：
    GET  /health          -> {gpu, device, torch, models:{demucs,musetalk}, version, reason?}
    POST /separate        -> {job_id}          轮询 GET /job/<id> -> result {vocals, background, time_s}
    POST /lipsync         -> {job_id}          -> result {video, offset_ms, width, height}
    POST /detect_mouth    -> {box, source, score} | 501
    GET  /models          -> {models:{...}, detail}
    POST /models/download -> {job_id | queued}
    GET  /models/jobs     -> {jobs:[{id,which,status,message,error,logs}]}

缺失依赖时服务仍然照常启动并给出可执行提示（不静默失败，§8 错误可见）：
/health 返回 200 + reason，Node 侧按 §3.6 走「跳过口型/回退云端」分支。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

VERSION = "0.1.0"
MAX_LOG_LINES = 400
JSON_HEADERS = {"Content-Type": "application/json; charset=utf-8"}

# 全局串行锁：本机 GPU 同一时刻只跑一个重任务（SPEC-001 §7.7-4）
GPU_LOCK = threading.Semaphore(1)
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()

ARGS: argparse.Namespace | None = None
STATE: dict[str, Any] = {"models_root": "", "ffmpeg": None, "python": sys.executable}
TORCH_CACHE: tuple[Any, bool, str | None] | None = None
TORCH_CACHE_LOCK = threading.Lock()


# --------------------------------------------------------------------- 工具


def log(msg: str) -> None:
    """写 stderr：主进程 sidecar.err 通道会落到项目日志目录。"""
    sys.stderr.write(f"[varidub-sidecar] {msg}\n")
    sys.stderr.flush()


def now_ms() -> int:
    return int(time.time() * 1000)


def as_abs(path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else (Path.cwd() / p).resolve()


def safe_json_loads(raw: str) -> dict[str, Any]:
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


# ----------------------------------------------------------------------- 任务


def job_new(kind: str, label: str) -> dict[str, Any]:
    job = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "label": label,
        "which": "",
        "status": "queued",
        "message": f"已入队：{label}",
        "logs": [],
        "result": None,
        "error": None,
        "created_ms": now_ms(),
        "started_ms": None,
        "finished_ms": None,
    }
    with JOBS_LOCK:
        JOBS[job["id"]] = job
    return job


def job_patch(job: dict[str, Any], **fields: Any) -> None:
    with JOBS_LOCK:
        job.update(fields)


def job_log(job: dict[str, Any], line: str) -> None:
    line = str(line).rstrip()
    if not line:
        return
    with JOBS_LOCK:
        job["logs"].append(line)
        if len(job["logs"]) > MAX_LOG_LINES:
            del job["logs"][: len(job["logs"]) - MAX_LOG_LINES]
        job["message"] = line[:300]
    log(f"{job['kind']}/{job['id']}: {line}")


def job_fail(job: dict[str, Any], error: str, hint: str | None = None) -> None:
    text = error if not hint else f"{error}｜{hint}"
    job_patch(job, status="error", error=text[:1200], message=text[:300], finished_ms=now_ms())
    log(f"任务失败：{text}")


def job_done(job: dict[str, Any], result: dict[str, Any]) -> None:
    job_patch(job, status="done", result=result, message="完成", finished_ms=now_ms())


def job_get(job_id: str) -> dict[str, Any] | None:
    with JOBS_LOCK:
        return JOBS.get(job_id)


def job_public(job: dict[str, Any]) -> dict[str, Any]:
    with JOBS_LOCK:
        return {
            "id": job["id"],
            "kind": job["kind"],
            "status": job["status"],
            "message": job["message"],
            "error": job["error"],
            "logs": list(job["logs"]),
            # client.ts submitAndWait 读 job.result 作为最终产物，不可省略
            "result": job["result"],
            "elapsed_ms": (job["finished_ms"] or now_ms()) - (job["started_ms"] or job["created_ms"]),
        }


def run_job(job: dict[str, Any], work: Callable[[dict[str, Any]], dict[str, Any]], serial: bool) -> None:
    """后台线程执行；serial=True 时排队占用 GPU 锁。"""

    def body() -> None:
        job_patch(job, status="running", started_ms=now_ms())
        acquired = False
        try:
            if serial:
                job_log(job, "等待本机 GPU 串行锁…")
                GPU_LOCK.acquire()
                acquired = True
            result = work(job)
            job_done(job, result)
        except KeyboardInterrupt:  # pragma: no cover
            job_fail(job, "收到中断信号")
        except Exception as err:  # noqa: BLE001 - 任何异常都要变成可读错误
            job_fail(job, f"{type(err).__name__}: {err}", getattr(err, "hint", None))
        finally:
            if acquired:
                GPU_LOCK.release()

    threading.Thread(target=body, name=f"job-{job['kind']}-{job['id']}", daemon=True).start()


class SidecarError(RuntimeError):
    """带可执行提示的错误（hint 会拼进 error 文本给 UI）。"""

    def __init__(self, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.hint = hint


# ----------------------------------------------------------------- 环境探测


def models_root() -> Path:
    return Path(STATE["models_root"])


def ffmpeg_path() -> str | None:
    if STATE["ffmpeg"]:
        return str(STATE["ffmpeg"])
    found = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    STATE["ffmpeg"] = found
    return found


def torch_info() -> tuple[Any, bool, str | None]:
    """返回 (torch 模块, 是否有 CUDA, torch 版本字符串)。

    CUDA 首次初始化可能耗时数秒，因此结果缓存，只探测一次；
    /health 会在预热完成前反复拿到「未探测」结果，不阻塞启动。
    """
    global TORCH_CACHE
    with TORCH_CACHE_LOCK:
        if TORCH_CACHE is not None:
            return TORCH_CACHE
    try:
        import torch  # type: ignore
    except Exception:  # noqa: BLE001
        info: tuple[Any, bool, str | None] = (None, False, None)
    else:
        try:
            gpu = bool(torch.cuda.is_available())
            device = torch.cuda.get_device_name(0) if gpu else "cpu"
            info = (torch, gpu, f"{torch.__version__} / {device}")
        except Exception:  # noqa: BLE001
            info = (torch, False, f"{torch.__version__} / cuda 探测失败")
    with TORCH_CACHE_LOCK:
        TORCH_CACHE = info
    return info


def demucs_files() -> list[Path]:
    """Demucs 权重可能落在 models-root 缓存或用户 ~/.cache，两处都认。"""
    candidates = [
        models_root() / "cache" / "torch" / "hdemucs",
        models_root() / "demucs",
        Path.home() / ".cache" / "torch" / "hdemucs",
    ]
    found: list[Path] = []
    for base in candidates:
        if not base.exists():
            continue
        for ext in ("*.th", "*.pth", "*.pt"):
            found.extend(sorted(base.rglob(ext)))
    return found


def demucs_importable() -> bool:
    try:
        import importlib.util

        return importlib.util.find_spec("demucs") is not None
    except Exception:  # noqa: BLE001
        return False


def musetalk_dir() -> Path | None:
    for raw in (os.environ.get("MUSETALK_DIR"), os.environ.get("VARIDUB_MUSETALK_DIR"), str(models_root() / "musetalk")):
        if not raw:
            continue
        p = Path(raw)
        if (p / "musetalk").is_dir() or (p / "inference.py").exists():
            return p
    return None


def lipsync_cmd_template() -> str | None:
    """口型后端的可执行入口：优先用户显式配置，其次官方仓库脚本约定。"""
    return os.environ.get("VARIDUB_LIPSYNC_CMD") or None


def musetalk_weights() -> list[Path]:
    base = models_root() / "musetalk"
    if not base.exists():
        return []
    hits: list[Path] = []
    for pattern in ("**/*.pkl", "**/*.pth", "**/*.safetensors", "**/musetalk*.json"):
        hits.extend(sorted(base.rglob(pattern)))
    return hits


def lipsync_entry() -> Path | None:
    """MuseTalk 仓库内的推理入口脚本（可用 VARIDUB_LIPSYNC_ENTRY 覆盖）。"""
    d = musetalk_dir()
    if d is None:
        return None
    override = os.environ.get("VARIDUB_LIPSYNC_ENTRY")
    if override:
        p = as_abs(override)
        return p if p.exists() else None
    for name in ("inference.py", "inference/inference.py", "inference/test.py"):
        if (d / name).exists():
            return d / name
    return None


def lipsync_backend() -> tuple[str | None, str | None]:
    """(backend, 不可用原因)。backend ∈ {cmd, repo}"""
    if lipsync_cmd_template():
        return "cmd", None
    d = musetalk_dir()
    if d is None:
        return None, "未找到 MuseTalk 代码（设 MUSETALK_DIR 指向已 clone 的仓库，或配 VARIDUB_LIPSYNC_CMD）"
    if not musetalk_weights():
        return None, "MuseTalk 权重未下载（设置页「下载本地模型」，或运行 sidecar/download_models.py --which musetalk）"
    if lipsync_entry() is None:
        return None, f"{d} 内未找到推理入口脚本（可用 VARIDUB_LIPSYNC_ENTRY 指定，或用 VARIDUB_LIPSYNC_CMD 接自定义命令）"
    return "repo", None


def health_payload() -> dict[str, Any]:
    _torch, gpu, torch_version = torch_info()
    demucs_ok = demucs_importable() and bool(demucs_files())
    backend, lipsync_reason = lipsync_backend()
    musetalk_ok = backend is not None
    reasons: list[str] = []
    if _torch is None:
        reasons.append("未安装 torch：请先在设置页完成「本地算力引导」")
    elif not gpu:
        reasons.append("torch 无 CUDA：Demucs/MuseTalk 会用 CPU，速度可能不可接受（§9 M0 需实测确认）")
    if not demucs_importable():
        reasons.append("未安装 demucs 包")
    elif not demucs_ok:
        reasons.append("Demucs 权重未下载")
    if not musetalk_ok:
        reasons.append(f"口型不可用：{lipsync_reason}")
    if not ffmpeg_path():
        reasons.append("ffmpeg 不在 PATH（主进程随包提供并注入 VARIDUB_FFMPEG，独立运行请自行安装）")
    return {
        "online": True,
        "gpu": gpu,
        "device": torch_version.split(" / ")[-1] if torch_version else None,
        "torch": torch_version,
        "models": {"demucs": demucs_ok, "musetalk": musetalk_ok},
        "version": VERSION,
        "reason": "；".join(reasons) if reasons else None,
        "lipsync_backend": backend,
        "python": sys.executable,
        "models_root": str(models_root()),
        "pid": os.getpid(),
    }


# ------------------------------------------------------------------- Demucs


def find_track(root: Path, names: tuple[str, ...]) -> Path | None:
    for name in names:
        for ext in ("wav", "flac", "mp3", "ogg"):
            hit = root / f"{name}.{ext}"
            if hit.exists():
                return hit
    return None


def run_separate(job: dict[str, Any], req: dict[str, Any]) -> dict[str, Any]:
    inp = req.get("input")
    out_dir = req.get("out_dir")
    if not inp or not out_dir:
        raise SidecarError("参数不完整：需要 input 与 out_dir")
    src = as_abs(str(inp))
    if not src.exists():
        raise SidecarError(f"待分离的音频不存在：{src}")
    out = as_abs(str(out_dir))
    out.mkdir(parents=True, exist_ok=True)
    model = str(req.get("model") or "htdemucs")
    two_stem = bool(req.get("two_stem", True))

    cmd = [sys.executable, "-m", "demucs", "-n", model, "-o", str(out)]
    if two_stem:
        cmd += ["--two-stem=vocals"]
    if req.get("mp3"):
        cmd += ["--mp3"]
    cmd.append(str(src))

    env = os.environ.copy()
    env.setdefault("XDG_CACHE_HOME", str(models_root() / "cache"))
    env.setdefault("TORCH_HOME", str(models_root() / "cache" / "torch"))
    env["PYTHONUNBUFFERED"] = "1"
    ff = ffmpeg_path()
    if ff:
        # demucs 内部按名字调 ffmpeg，把它所在目录前置到子进程 PATH
        env["PATH"] = str(Path(ff).parent) + os.pathsep + env.get("PATH", "")
        env.setdefault("VARIDUB_FFMPEG", ff)

    job_log(job, f"Demucs 开始：{' '.join(cmd[:6])} … {src.name}")
    started = time.time()
    proc = subprocess.Popen(cmd, cwd=str(out), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    assert proc.stdout is not None
    for line in proc.stdout:
        text = line.rstrip()
        if text:
            job_log(job, text[:300])
    code = proc.wait()
    if code != 0:
        raise SidecarError(
            f"Demucs 退出码 {code}",
            "常见原因：ffmpeg 缺失 / 显存不足（加 --segment 或改用 CPU）/ 权重下载失败（先跑 download_models.py）",
        )

    track_dir = out / model / src.stem
    vocals = find_track(track_dir, ("vocals",)) or find_track(out / model, (f"{src.stem}_vocals", "vocals"))
    if vocals is None:
        matches = sorted(out.rglob("vocals.*"))
        vocals = matches[0] if matches else None
    if vocals is None:
        raise SidecarError("Demucs 未产出人声轨", f"检查输出目录结构：{out / model}")
    bgm = find_track(track_dir, ("no_vocals", "background", "accompaniment"))
    if bgm is None:
        matches = sorted(out.rglob("no_vocals.*"))
        bgm = matches[0] if matches else None
    elapsed = round(time.time() - started, 1)
    job_log(job, f"人声轨={vocals.name}｜背景轨={(bgm.name if bgm else '缺失')}｜耗时 {elapsed}s")
    return {"vocals": str(vocals), "background": str(bgm) if bgm else None, "time_s": elapsed}


# ------------------------------------------------------------------ MuseTalk


def probe_size(path: str, fps: float) -> tuple[int, int, float]:
    """用 ffmpeg 探测分辨率与帧率（不依赖 ffprobe）。返回 (宽, 高, fps)。"""
    ff = ffmpeg_path()
    if not ff:
        return 0, 0, fps
    cmd = [ff, "-hide_banner", "-i", path, "-frames:v", "1", "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    except Exception:  # noqa: BLE001
        return 0, 0, fps
    text = (proc.stderr or "") + (proc.stdout or "")
    m = re.search(r"(\d{2,5})x(\d{2,5})", text)
    fps_m = re.search(r"(\d+(?:\.\d+)?)\s*fps", text)
    width = int(m.group(1)) if m else 0
    height = int(m.group(2)) if m else 0
    return width, height, float(fps_m.group(1)) if fps_m else fps


def expand_template(template: str, values: dict[str, str]) -> list[str]:
    """把命令模板按空白切分并做 {key} 替换（用 replace 而非 str.format，避免路径里的括号抛 KeyError）。"""
    parts = [part for part in template.split(" ") if part]
    out: list[str] = []
    for part in parts:
        for key, value in values.items():
            part = part.replace("{%s}" % key, value)
        out.append(part)
    return out


def run_lipsync(job: dict[str, Any], req: dict[str, Any]) -> dict[str, Any]:
    video = req.get("video")
    audio = req.get("audio")
    out = req.get("out")
    if not video or not audio or not out:
        raise SidecarError("参数不完整：需要 video / audio / out")
    for path in (video, audio):
        if not as_abs(str(path)).exists():
            raise SidecarError(f"输入文件不存在：{path}")
    backend, reason = lipsync_backend()
    if backend is None:
        raise SidecarError("MuseTalk 不可用", reason)

    out_path = as_abs(str(out))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fps = float(req.get("fps") or 30)
    width, height, real_fps = probe_size(str(as_abs(str(video))), fps)
    job_log(job, f"口型后端={backend}｜输入 {width}x{height}@{real_fps:g}fps")

    if backend == "cmd":
        template = lipsync_cmd_template() or ""
        cmd = expand_template(
            template,
            {
                "video": str(as_abs(str(video))),
                "audio": str(as_abs(str(audio))),
                "out": str(out_path),
                "fps": str(int(fps)),
                "box": ",".join(str(v) for v in (req.get("box") or [])),
                "models_root": str(models_root()),
            },
        )
        if not cmd:
            raise SidecarError("VARIDUB_LIPSYNC_CMD 为空", "填写可直接运行的命令模板，支持 {video} {audio} {out} {fps}")
        started = time.time()
        job_log(job, f"执行：{cmd[0]} …（共 {len(cmd)} 个参数）")
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.strip():
                job_log(job, line.rstrip()[:300])
        code = proc.wait()
        if code != 0:
            raise SidecarError(f"VARIDUB_LIPSYNC_CMD 退出码 {code}", "确认命令可在本机手动跑通，且产物写到 {out}")
    else:
        started = time.time()
        entry = lipsync_entry()
        if entry is None:
            raise SidecarError("MuseTalk 入口脚本缺失", "配 VARIDUB_LIPSYNC_ENTRY，或改用 VARIDUB_LIPSYNC_CMD")
        work_dir = out_path.parent / "musetalk_work"
        work_dir.mkdir(parents=True, exist_ok=True)
        cfg = write_inference_config(work_dir, str(as_abs(str(video))), str(as_abs(str(audio))))
        extra = os.environ.get("VARIDUB_LIPSYNC_ARGS")
        cmd = [sys.executable, str(entry)]
        if extra:
            cmd += expand_template(extra, {"cfg": str(cfg), "out": str(out_path), "work": str(work_dir), "video": str(as_abs(str(video))), "audio": str(as_abs(str(audio)))})
        else:
            cmd += ["--inference_config", str(cfg), "--result_dir", str(work_dir)]
        job_log(job, f"调用入口：{entry.name}（cfg={cfg.name}）")
        proc = subprocess.Popen(
            cmd,
            cwd=str(entry.parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={**os.environ, "PYTHONUNBUFFERED": "1", "VARIDUB_MODEL_ROOT": str(models_root())},
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.strip():
                job_log(job, line.rstrip()[:300])
        code = proc.wait()
        produced = collect_lipsync_output(work_dir, out_path)
        if produced is None:
            raise SidecarError(
                f"MuseTalk 未产出视频（退出码 {code}）",
                "不同版本入口参数不一致：用 VARIDUB_LIPSYNC_ARGS 覆盖（支持 {cfg} {out} {work} 占位），或直接用 VARIDUB_LIPSYNC_CMD",
            )
    if not out_path.exists():
        raise SidecarError("MuseTalk 未产出视频", f"期望输出路径 {out_path}")

    offset_ms = measure_audio_offset(str(out_path), str(as_abs(str(audio))))
    job_log(job, f"口型完成：{out_path.name}（音画偏移 {offset_ms}ms）")
    return {
        "video": str(out_path),
        "offset_ms": offset_ms,
        "offset_frames": int(round(offset_ms / 1000.0 * fps)),
        "width": width or None,
        "height": height or None,
        "time_s": round(time.time() - started, 1),
    }


def write_inference_config(work_dir: Path, video: str, audio: str) -> Path:
    """生成 MuseTalk 推理配置。

    不同版本读的键不完全一致（v15 多为 tasks 列表，早期版本为 video_info），
    因此两种都写上；对不上时用 VARIDUB_LIPSYNC_ENTRY / VARIDUB_LIPSYNC_ARGS /
    VARIDUB_LIPSYNC_CMD 接管（见 sidecar/README.md）。
    """
    bbox_shift = os.environ.get("VARIDUB_BBOX_SHIFT", "0")
    text = (
        "# 由 VariDub sidecar 自动生成\n"
        "video_info:\n"
        f'  video_path: "{video}"\n'
        f'  audio_path: "{audio}"\n'
        f"  bbox_shift: {bbox_shift}\n"
        "tasks:\n"
        f'  - video_path: "{video}"\n'
        f'    audio_path: "{audio}"\n'
        f"    bbox_shift: {bbox_shift}\n"
        f"    start_idx: 0\n"
    )
    cfg = work_dir / "varidub_inference.yaml"
    cfg.write_text(text, encoding="utf-8")
    return cfg


def collect_lipsync_output(work_dir: Path, out_path: Path) -> Path | None:
    """在 MuseTalk 工作目录里找最新产出的视频，归位到约定输出路径。"""
    videos = [p for p in work_dir.rglob("*.mp4") if p.stat().st_size > 1024]
    if not videos:
        return None
    newest = max(videos, key=lambda p: p.stat().st_mtime)
    if newest.resolve() != out_path.resolve():
        shutil.copyfile(newest, out_path)
    return out_path


def measure_audio_offset(_video: str, audio: str) -> int:
    """成片配音轨起始 vs 期望起点的粗偏移：用 ffmpeg silencedetect 估首字静音长度。"""
    ff = ffmpeg_path()
    if not ff:
        return 0
    try:
        proc = subprocess.run(
            [ff, "-hide_banner", "-i", audio, "-af", "silencedetect=noise=-40dB:d=0.08", "-f", "null", "-"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
        m = re.search(r"silence_end:\s*([0-9.]+)", proc.stderr or "")
        return int(round(float(m.group(1)) * 1000)) if m else 0
    except Exception:  # noqa: BLE001
        return 0


# --------------------------------------------------------------- 嘴部定位


def run_detect_mouth(req: dict[str, Any]) -> dict[str, Any]:
    video = req.get("video")
    if not video:
        raise SidecarError("参数不完整：需要 video")
    at_ms = int(req.get("at_ms") or 0)
    try:
        import cv2  # type: ignore
    except Exception as err:  # noqa: BLE001
        err = SidecarError("未安装 opencv，无法做嘴部定位", "pip install opencv-python，或让步骤⑥使用默认嘴部框")
        err.http_status = 501  # type: ignore[attr-defined]
        raise err
    ff = ffmpeg_path()
    if not ff:
        raise SidecarError("ffmpeg 缺失，无法取帧", "由主进程注入 VARIDUB_FFMPEG，或安装 ffmpeg 到 PATH")
    tmp = Path(os.environ.get("TEMP", "/tmp")) / f"varidub_mouth_{uuid.uuid4().hex[:8]}.png"
    subprocess.run(
        [ff, "-hide_banner", "-loglevel", "error", "-ss", f"{at_ms / 1000:.3f}", "-i", str(as_abs(str(video))), "-frames:v", "1", "-y", str(tmp)],
        capture_output=True,
    )
    frame = cv2.imread(str(tmp))
    if tmp.exists():
        tmp.unlink(missing_ok=True)
    if frame is None:
        raise SidecarError(f"取帧失败：{video} @ {at_ms}ms")
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    mouth_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_mcs_mouth.xml")
    faces = face_cascade.detectMultiScale(gray, 1.15, 4)
    if len(faces) == 0:
        h, w = gray.shape
        return {"box": [int(w * 0.35), int(h * 0.55), int(w * 0.3), int(h * 0.3)], "source": "fallback-center", "score": None}
    x, y, fw, fh = sorted(faces.tolist(), key=lambda b: b[2] * b[3], reverse=True)[0]
    roi = gray[y : y + fh, x : x + fw]
    mouths = mouth_cascade.detectMultiScale(roi, 1.7, 3) if not mouth_cascade.empty() else []
    if len(mouths) == 0:
        return {
            "box": [int(x + fw * 0.25), int(y + fh * 0.66), int(fw * 0.5), int(fh * 0.28)],
            "source": "face-heuristic",
            "score": None,
        }
    mx, my, mw, mh = sorted(mouths.tolist(), key=lambda b: b[2] * b[3], reverse=True)[0]
    return {"box": [int(x + mx), int(y + my), int(mw), int(mh)], "source": "opencv-mouth", "score": 0.9}


# ------------------------------------------------------------------- 模型下载


def run_model_download(job: dict[str, Any], req: dict[str, Any]) -> dict[str, Any]:
    which = str(req.get("which") or "all")
    script = Path(__file__).with_name("download_models.py")
    if not script.exists():
        raise SidecarError(f"未找到 {script}")
    cmd = [sys.executable, str(script), "--models-root", str(models_root()), "--which", which]
    job_log(job, f"开始下载模型：{which}")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "PYTHONUNBUFFERED": "1", "XDG_CACHE_HOME": str(models_root() / "cache")},
    )
    assert proc.stdout is not None
    summary: dict[str, Any] = {}
    for line in proc.stdout:
        text = line.strip()
        if not text:
            continue
        if text.startswith("{"):
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict):
                if payload.get("event") == "progress":
                    received = payload.get("received") or 0
                    total = payload.get("total") or 0
                    pct = f"{received / total * 100:.1f}%" if total else f"{received / 1024 / 1024:.1f}MB"
                    job_log(job, f"{payload.get('which')} 进度 {pct} — {payload.get('phase', '')}")
                elif payload.get("event") == "done":
                    summary = payload
                    job_log(job, f"{payload.get('which')} 完成：{payload.get('detail', '')}")
                continue
        job_log(job, text[:300])
    code = proc.wait()
    if code != 0:
        raise SidecarError(f"download_models.py 退出码 {code}", "多为网络受限：可用代理或手动放置权重到 models-root")
    return {"which": which, "summary": summary, "demucs": len(demucs_files()) > 0, "musetalk": bool(musetalk_weights())}


# --------------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = f"VariDubSidecar/{VERSION}"
    protocol_version = "HTTP/1.1"

    # -------------------------------------------------------- 基础响应
    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        for key, value in JSON_HEADERS.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:  # 降噪：只保留异常
        text = fmt % args
        if " 200 " in text or " 204 " in text:
            return
        log(f"http {text}")

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 4 * 1024 * 1024:
            raise SidecarError("请求体过大")
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        return safe_json_loads(raw)

    # -------------------------------------------------------- 路由
    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
        try:
            path = self.path.split("?", 1)[0]
            if path == "/health":
                self._send(200, health_payload())
            elif path.startswith("/job/"):
                job = job_get(path[len("/job/") :])
                if job is None:
                    self._send(404, {"error": "未知 job_id"})
                else:
                    self._send(200, job_public(job))
            elif path == "/models":
                demucs_ok = bool(demucs_files())
                base = models_root()
                self._send(
                    200,
                    {
                        "models": {
                            "demucs": {"available": demucs_ok, "path": str(base / "cache" / "torch" / "hdemucs"), "files": [f.name for f in demucs_files()[:8]]},
                            "musetalk": {
                                "available": lipsync_backend()[0] is not None,
                                "path": str(base / "musetalk"),
                                "files": [f.name for f in musetalk_weights()[:8]],
                            },
                        },
                        "detail": f"models-root={base}｜python={sys.executable}｜torch={torch_info()[2]}",
                    },
                )
            elif path == "/models/jobs":
                with JOBS_LOCK:
                    snapshot = list(JOBS.values())
                snapshot.sort(key=lambda item: item["created_ms"], reverse=True)
                out = []
                for job in snapshot:
                    if job["kind"] != "model-download":
                        continue
                    public = job_public(job)
                    public["which"] = job.get("which") or str((job.get("result") or {}).get("which") or "")
                    public["created_ms"] = job["created_ms"]
                    out.append(public)
                self._send(200, {"jobs": out[:30]})
            elif path in ("/", "/info"):
                self._send(200, {"name": "varidub-sidecar", "version": VERSION, "endpoints": ["/health", "/job/<id>", "/separate", "/lipsync", "/detect_mouth", "/models", "/models/download", "/models/jobs"]})
            else:
                self._send(404, {"error": f"未知路径 {path}"})
        except Exception as err:  # noqa: BLE001
            self._send(500, {"error": f"{type(err).__name__}: {err}"})

    def do_POST(self) -> None:  # noqa: N802
        status = 200
        try:
            path = self.path.split("?", 1)[0]
            body = self._read_body()
            if path == "/separate":
                job = job_new("separate", "Demucs 人声分离")
                run_job(job, lambda j: run_separate(j, body), serial=True)
                self._send(200, {"job_id": job["id"], "status": "queued"})
            elif path == "/lipsync":
                job = job_new("lipsync", "MuseTalk 口型对齐")
                run_job(job, lambda j: run_lipsync(j, body), serial=True)
                self._send(200, {"job_id": job["id"], "status": "queued"})
            elif path == "/detect_mouth":
                self._send(200, run_detect_mouth(body))
            elif path == "/models/download":
                which = str(body.get("which") or "all")
                job = job_new("model-download", f"下载模型 {which}")
                job["which"] = which
                run_job(job, lambda j: run_model_download(j, body), serial=False)
                self._send(200, {"job_id": job["id"], "which": which, "status": "queued"})
            elif path == "/health":
                self._send(200, health_payload())
            else:
                status = 404
                self._send(status, {"error": f"未知路径 {path}"})
        except SidecarError as err:
            status = getattr(err, "http_status", 500)
            self._send(status, {"error": str(err), "hint": err.hint})
        except Exception as err:  # noqa: BLE001
            self._send(500, {"error": f"{type(err).__name__}: {err}"})

    def do_OPTIONS(self) -> None:  # noqa: N802 - 便于本地 curl/浏览器调试
        self._send(200, {"ok": True})


# --------------------------------------------------------------------- 入口


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VariDub 本地推理 sidecar（Demucs / MuseTalk）")
    parser.add_argument("--port", type=int, default=0, help="监听端口，0 表示随机分配（就绪后打印实际端口）")
    parser.add_argument("--host", default="127.0.0.1", help="仅允许回环地址")
    parser.add_argument("--models-root", default=None, help="本地模型目录（默认环境变量 VARIDUB_MODEL_ROOT）")
    parser.add_argument("--ffmpeg", default=None, help="ffmpeg 可执行文件路径（默认 VARIDUB_FFMPEG 或 PATH）")
    parser.add_argument("--cpu", action="store_true", help="强制 CPU（无 CUDA 时的显式降级）")
    return parser.parse_args()


def warm_environment() -> None:
    """后台预热：探测 torch/CUDA 并再打印一行环境摘要（不阻塞 serve_forever）。"""
    try:
        payload = health_payload()
        print(
            json.dumps(
                {
                    "event": "env",
                    "gpu": payload["gpu"],
                    "torch": payload["torch"],
                    "models": payload["models"],
                    "lipsync_backend": payload["lipsync_backend"],
                    "reason": payload["reason"],
                }
            ),
            flush=True,
        )
    except Exception as err:  # noqa: BLE001
        log(f"环境预热失败：{type(err).__name__}: {err}")


def main() -> int:
    global ARGS
    ARGS = parse_args()
    if ARGS.host not in ("127.0.0.1", "localhost", "::1"):
        log(f"拒绝监听非回环地址 {ARGS.host}")
        return 2
    root = ARGS.models_root or os.environ.get("VARIDUB_MODEL_ROOT") or str(Path.home() / ".cache" / "varidub" / "models")
    STATE["models_root"] = str(Path(root))
    Path(STATE["models_root"]).mkdir(parents=True, exist_ok=True)
    STATE["ffmpeg"] = ARGS.ffmpeg or os.environ.get("VARIDUB_FFMPEG") or None

    if ARGS.cpu:
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

    server = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    # 这一行是主进程抓取端口的唯一依据，勿改格式（manager.ts 依赖）
    print(json.dumps({"event": "ready", "port": port, "pid": os.getpid(), "version": VERSION, "models_root": STATE["models_root"]}), flush=True)
    # 就绪后立刻开始 accept；torch/CUDA 探测放后台，避免主进程的 /health 8s 超时
    threading.Thread(target=warm_environment, name="warm-env", daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到 Ctrl-C，退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
