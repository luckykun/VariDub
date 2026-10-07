# sidecar —— 本地推理子进程（Demucs / MuseTalk）

对应 SPEC-001 §7.4、§7.5、§7.8。Electron 主进程负责它的启停与崩溃拉起（`src/main/sidecar/manager.ts`），
本目录只关心 Python 侧。渲染层永远不直接连它。

## 文件

| 文件                   | 作用                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `server.py`            | 小型 HTTP 服务：`/health` `/separate` `/lipsync` `/detect_mouth` `/models*` |
| `download_models.py`   | 首次运行拉取权重（进度以 JSON 行打印到 stdout）                              |
| `requirements.txt`     | CUDA 12.1 依赖（主进程引导首选）                                            |
| `requirements-cpu.txt` | CPU 兜底依赖（CUDA 装不上时自动回退）                                       |

只用标准库起服务，不引入 FastAPI/Flask —— 少一层依赖就少一类装不上的情况。

## 快速开始（推荐：应用内一键）

设置页 → 本地算力 → 「一键引导环境」：主进程会按 `venv → 系统 Python 3.11 → 便携版 Python`
顺序找解释器，建 `sidecar/.venv`，`pip install -r requirements.txt`（失败自动改试 CPU 版），
再拉起 `server.py`。全部进度走 SSE 到 UI 日志面板。

## 手动搭建（联调 / 想自己控环境）

```powershell
# 需要真实 Python 3.11（Windows 里 Microsoft Store 的 python.exe 占位符不算，主进程会识别并跳过）
py -3.11 -m venv sidecar\.venv
sidecar\.venv\Scripts\python.exe -m pip install --upgrade pip
sidecar\.venv\Scripts\python.exe -m pip install -r sidecar\requirements.txt

# 拉 Demucs 权重（落到 %LOCALAPPDATA%\VariDub\models\cache\torch\hdemucs）
sidecar\.venv\Scripts\python.exe sidecar\download_models.py --models-root "$env:LOCALAPPDATA\VariDub\models" --which demucs

# 单独跑服务：--port 0 表示随机端口，就绪后 stdout 打印 {"event":"ready","port":N,...}
sidecar\.venv\Scripts\python.exe sidecar\server.py --port 0 --models-root "$env:LOCALAPPDATA\VariDub\models"
```

冒烟验证：

```powershell
curl.exe http://127.0.0.1:<port>/health
curl.exe http://127.0.0.1:<port>/models
```

主进程与 sidecar 可独立重启（§7.8）：改 Python 只需重启 sidecar，改 Node 编排只需重启应用。

## 口型（MuseTalk）接入方式

MuseTalk 不在 PyPI，且各版本推理入口参数不一致，所以 sidecar 把它做成**可插拔后端**，按优先级：

1. `VARIDUB_LIPSYNC_CMD` —— 自定义命令模板，空白分隔，支持占位符
   `{video} {audio} {out} {fps} {box} {models_root}`。例：

   ```powershell
   $env:VARIDUB_LIPSYNC_CMD = "python C:\repos\MuseTalk\inference.py --video {video} --audio {audio} --out {out}"
   ```

2. `MUSETALK_DIR` 指向已 clone 的仓库（或 `<models-root>/musetalk/src`），配 `VARIDUB_LIPSYNC_ENTRY`
   指定入口脚本、`VARIDUB_LIPSYNC_ARGS` 指定参数串（占位符 `{cfg} {out} {work} {video} {audio}`）。
   不设 ARGS 时默认执行 `python <entry> --inference_config <自动生成的 yaml> --result_dir <work>`，
   生成的配置同时写了 `video_info` 与 `tasks` 两种键形，以覆盖不同版本。

3. 权重目录 `<models-root>/musetalk`（`download_models.py --which musetalk` 负责）。

三者都不满足时 `/health` 里 `models.musetalk=false` 并给出中文原因，**步骤⑥ 会跳过口型、
仍产出成片**（§3.6 降级路径），口型检测报告里对应句标为「跳过」。

## 环境变量一览

| 变量                    | 默认                        | 说明                                        |
| ----------------------- | --------------------------- | ------------------------------------------- |
| `VARIDUB_MODEL_ROOT`    | `%LOCALAPPDATA%\VariDub\models` | 模型根目录（主进程注入 `--models-root`）  |
| `VARIDUB_FFMPEG`        | ffmpeg-static 二进制        | 主进程注入；独立运行时需自行装 ffmpeg 到 PATH |
| `VARIDUB_LIPSYNC_CMD`   | —                           | 口型后端命令模板（方式 1）                   |
| `MUSETALK_DIR`          | —                           | MuseTalk 仓库目录（方式 2）                  |
| `VARIDUB_LIPSYNC_ENTRY` | `inference.py`              | 仓库内入口脚本                              |
| `VARIDUB_LIPSYNC_ARGS`  | `--inference_config {cfg} --result_dir {work}` | 入口参数                         |
| `VARIDUB_DEMUCS_MODEL`  | `htdemucs`                  | Demucs 模型名                               |
| `VARIDUB_MUSETALK_REPO` | `TMElyralab/MuseTalk`       | 权重所在 HF 仓库                            |
| `VARIDUB_BBOX_SHIFT`    | `0`                         | 嘴部框偏移                                  |

## 行为约定

* 只监听 `127.0.0.1`，非回环地址直接拒绝启动。
* GPU 串行锁 `GPU_LOCK`：本机同一时刻只跑一个重任务（与主进程 `gpuQueue` 双层保险，§7.7-4）。
* 长任务一律「POST 返回 `job_id` → 轮询 `/job/<id>`」，`logs` 为增量尾行，主进程落到项目 `logs/`。
* 任何缺依赖的情况都返回可读中文原因 + 下一步动作，不抛裸栈。
* `--cpu` 强制 `CUDA_VISIBLE_DEVICES=-1`，用于对比实测（§9 M0 的 1660 Ti 硬前置）。

## 故障排查

| 现象                              | 处理                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| 「未找到可用 Python 环境」        | 商店占位 python 会被跳过；装 3.11 或用设置页「一键引导」下载便携版     |
| `/health` 有「ffmpeg 不在 PATH」  | 由主进程启动时正常；手动跑 `server.py` 请加 `--ffmpeg <路径>`          |
| Demucs 退出码非 0 / 显存不足      | 试 `--cpu`，或在 requirements 换更小模型；仍失败按 §9 M0 走云端端口型 |
| 「MuseTalk 权重未下载」           | 跑 `download_models.py --which musetalk`，或按上面方式 1 接自定义命令 |
| 端口抓取失败、60s 启动超时        | 看 stderr 是否有 torch 导入错误；首次 CUDA 初始化慢已放后台，不应超时 |
