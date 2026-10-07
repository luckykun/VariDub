#!/usr/bin/env python3
"""VariDub 本地模型首次拉取（SPEC-001 §7.4「download_models.py：首次运行拉取模型（进度回调）」）。

设计原则：**不写死任何权重 URL**。
* Demucs：调用 demucs 自己的 `get_model()`，它按官方源解析文件名与地址；
  通过 XDG_CACHE_HOME / TORCH_HOME 把落点固定在 --models-root 下，便于应用管理体积。
* MuseTalk：代码不在 PyPI（官方仓库 TMElyralab/MuseTalk），本脚本优先用
  huggingface_hub 拉官方权重目录；没装 hf_hub 时退化为 git clone 代码 + 提示手动放置权重。

进度回调 = 向 stdout 逐行打印 JSON，供 server.py / sidecar 前端消费：

    {"event":"progress","which":"demucs","phase":"weights","received":123456,"total":0}
    {"event":"done","which":"demucs","detail":"...","bytes":80321024,"files":[...]}

单独运行（联调，SPEC-001 §7.8）：
    python sidecar/download_models.py --models-root D:/Vardub_Workspace/models --which all
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

Progress = Callable[[str, str, int, int], None]

MUSETALK_HF_REPO = os.environ.get("VARIDUB_MUSETALK_REPO", "TMElyralab/MuseTalk")
MUSETALK_GIT_URL = os.environ.get("VARIDUB_MUSETALK_GIT", "https://github.com/TMElyralab/MuseTalk.git")
# 权重目录里的推理相关子集，避免把整个仓库（含示例视频）拉下来
MUSETALK_ALLOW_PATTERNS = ["musetalk/*", "musetalkV15/*", "sd-vae/*", "*config*.json", "*.pkl", "*.pth", "*.safetensors"]


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for item in path.rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            continue
    return total


def watch_growth(target: Path, stop: threading.Event, which: str, phase: str) -> None:
    """后台线程：目录体积增长即为进度（官方下载器不提供统一回调，这样最省事也最准）。"""
    last = -1
    while not stop.wait(1.0):
        current = dir_bytes(target)
        if current != last:
            emit({"event": "progress", "which": which, "phase": phase, "received": current, "total": 0})
            last = current


def mark_ready(root: Path, which: str, info: dict[str, Any]) -> None:
    stamp = root / which / ".ready.json"
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(json.dumps({"which": which, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), **info}, ensure_ascii=False, indent=2), encoding="utf-8")


# ------------------------------------------------------------------- Demucs


def download_demucs(root: Path, on_progress: Progress) -> dict[str, Any]:
    cache = root / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["XDG_CACHE_HOME"] = str(cache)
    os.environ["TORCH_HOME"] = str(cache / "torch")
    on_progress("demucs", "import", 0, 0)
    try:
        from demucs.pretrained import get_model  # type: ignore
    except Exception as err:  # noqa: BLE001
        raise RuntimeError(f"未安装 demucs 包（{err}），请先 pip install -r requirements.txt")

    model_name = os.environ.get("VARIDUB_DEMUCS_MODEL", "htdemucs")
    target = cache / "torch" / "hdemucs"
    stop = threading.Event()
    watcher = threading.Thread(target=watch_growth, args=(target, stop, "demucs", "weights"), daemon=True)
    watcher.start()
    try:
        on_progress("demucs", "weights", 0, 0)
        model = get_model(model_name)
        sig = model.sampling_rate if hasattr(model, "sampling_rate") else 44100
    finally:
        stop.set()
        watcher.join(timeout=2)

    files = [p for ext in ("*.th", "*.pth", "*.pt") for p in target.rglob(ext)] if target.exists() else []
    if not files:
        # 有些版本落到用户默认缓存，一并识别，避免 UI 误报「未下载」
        fallback = Path.home() / ".cache" / "torch" / "hdemucs"
        files = [p for ext in ("*.th", "*.pth", "*.pt") for p in fallback.rglob(ext)] if fallback.exists() else []
    if not files:
        raise RuntimeError(f"{model_name} 权重下载后未在 {target} 找到 .th/.pth 文件")
    total = sum(p.stat().st_size for p in files)
    detail = f"{model_name} 就绪（{len(files)} 个文件 / {total / 1024 / 1024:.1f} MB，采样率 {sig}）"
    mark_ready(root, "cache", {"files": [str(p) for p in files], "bytes": total})
    return {"which": "demucs", "detail": detail, "bytes": total, "files": [str(p) for p in files], "path": str(target)}


# ------------------------------------------------------------------ MuseTalk


def git_clone(url: str, dest: Path, on_progress: Progress) -> bool:
    git = shutil.which("git")
    if not git:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    on_progress("musetalk", "clone", 0, 0)
    proc = subprocess.run([git, "clone", "--depth", "1", url, str(dest)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        emit({"event": "progress", "which": "musetalk", "phase": "clone", "received": 0, "total": 0, "note": (proc.stderr or "").strip()[:300]})
        return False
    return dest.exists()


def download_musetalk(root: Path, on_progress: Progress) -> dict[str, Any]:
    dest = root / "musetalk"
    dest.mkdir(parents=True, exist_ok=True)
    on_progress("musetalk", "weights", 0, 0)

    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception as err:  # noqa: BLE001
        # 没装 hf_hub：只 clone 代码，权重需人工放置
        cloned = git_clone(MUSETALK_GIT_URL, dest / "src", on_progress) if not (dest / "src" / "inference.py").exists() else True
        raise RuntimeError(
            "未安装 huggingface_hub，无法自动拉取 MuseTalk 权重"
            + ("；代码已 clone 到 %s，请照官方 README 手动放置权重后重跑" % (dest / "src") if cloned else "，且 git 不可用，无法 clone 代码")
            + f"（原始错误：{err}）"
        )

    stop = threading.Event()
    watcher = threading.Thread(target=watch_growth, args=(dest, stop, "musetalk", "weights"), daemon=True)
    watcher.start()
    try:
        kwargs: dict[str, Any] = {
            "repo_id": MUSETALK_HF_REPO,
            "allow_patterns": MUSETALK_ALLOW_PATTERNS,
            "local_dir": str(dest),
        }
        try:
            # local_dir_use_symlinks 在新版 huggingface_hub 已弃用/移除，带上它反而报错
            path = snapshot_download(local_dir_use_symlinks=False, **kwargs)  # type: ignore[call-arg]
        except TypeError:
            path = snapshot_download(**kwargs)
    finally:
        stop.set()
        watcher.join(timeout=2)

    # 代码仓库：口型推理入口需要它（已存在则跳过）
    src_dir = dest / "src"
    if not (src_dir / "inference.py").exists():
        if not git_clone(MUSETALK_GIT_URL, src_dir, on_progress):
            emit({"event": "progress", "which": "musetalk", "phase": "clone", "received": 0, "total": 0, "note": "git 不可用或 clone 失败：手动 clone 后设 MUSETALK_DIR 指向仓库目录"})

    weights = [p for pattern in ("**/*.pkl", "**/*.pth", "**/*.safetensors") for p in dest.rglob(pattern)]
    total = sum(p.stat().st_size for p in weights)
    if not weights:
        raise RuntimeError(f"MuseTalk 下载结束但未找到权重文件（目录 {path}）")
    mark_ready(root, "musetalk", {"repo": MUSETALK_HF_REPO, "bytes": total, "files": len(weights)})
    return {
        "which": "musetalk",
        "detail": f"权重 {len(weights)} 个 / {total / 1024 / 1024:.1f} MB；代码目录 {src_dir}（如为空请手动 clone 后设 MUSETALK_DIR）",
        "bytes": total,
        "files": [str(p) for p in weights[:20]],
        "path": str(dest),
    }


# --------------------------------------------------------------------- CLI


def make_progress(which: str) -> Progress:
    def cb(_which: str, phase: str, received: int, total: int) -> None:
        emit({"event": "progress", "which": _which or which, "phase": phase, "received": received, "total": total})

    return cb


def main() -> int:
    parser = argparse.ArgumentParser(description="拉取 VariDub 本地模型（Demucs / MuseTalk）")
    parser.add_argument("--models-root", default=os.environ.get("VARIDUB_MODEL_ROOT"), help="模型目录（必填，应用会传 %LOCALAPPDATA%/VariDub/models）")
    parser.add_argument("--which", choices=["demucs", "musetalk", "all"], default="all")
    parser.add_argument("--skip-musetalk", action="store_true", help="只装 Demucs（MuseTalk 之后再手动接）")
    args = parser.parse_args()

    if not args.models_root:
        emit({"event": "error", "detail": "缺少 --models-root（或环境变量 VARIDUB_MODEL_ROOT）"})
        return 2
    root = Path(args.models_root)
    root.mkdir(parents=True, exist_ok=True)

    wanted = ["demucs", "musetalk"] if args.which == "all" else [args.which]
    if args.skip_musetalk and "musetalk" in wanted:
        wanted.remove("musetalk")

    failures: list[str] = []
    results: list[dict[str, Any]] = []
    for which in wanted:
        handler = download_demucs if which == "demucs" else download_musetalk
        cb = make_progress(which)
        try:
            result = handler(root, cb)
            results.append(result)
            emit({"event": "done", "which": which, "detail": result["detail"], "bytes": result["bytes"]})
        except Exception as err:  # noqa: BLE001
            failures.append(f"{which}: {err}")
            emit({"event": "failed", "which": which, "detail": str(err)})

    if failures:
        emit({"event": "summary", "ok": False, "detail": "；".join(failures), "results": results})
        return 1
    emit({"event": "summary", "ok": True, "detail": f"已就绪：{', '.join(wanted)}", "results": results})
    return 0


if __name__ == "__main__":
    sys.exit(main())
