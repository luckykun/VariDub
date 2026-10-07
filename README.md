# VariDub（综译）

中文综艺片段 → **3D 动画风格 + 英文配音**的本地流水线桌面应用：画面重绘为 3D 但保持人物/场景/构图一致，英文配音复刻原说话人音色，全程分步可控、每步可检查可修改可重跑。

- 定位：单人自用本地桌面应用，**仅支持 Windows**
- 需求与规格的唯一来源：[specs/SPEC-001-产品与技术规格.md](specs/SPEC-001-产品与技术规格.md)（本文只讲「怎么跑起来」，规则细节以 SPEC 为准）
- Python 本地推理子环境：[sidecar/README.md](sidecar/README.md)

---

## 1. 功能

### 1.1 六步流水线

导入视频 → 前置检查（时长/人声/画面三项）→ 进入项目详情，按步骤推进。**上一步未「确认」时，本步按钮为锁定态**——越贵的操作越要小样本先行。

| 步骤 | 做什么 | 主要模型 | 落盘产物 |
| --- | --- | --- | --- |
| ① 视频解析 | 视觉理解模型扫全片，按镜头切分镜，输出分镜表（起止/场景/出镜人物），可拖切点、合并拆分 | 时段路由 `qwen3.8-max`/`flash`，兜底本地 PySceneDetect | `shots.json` + 分镜缩略图 |
| ② 人声分离·中文识别 | Demucs 分离人声/背景轨 → ASR 逐句转写 + 说话人分离 → 为每位说话人登记音色样本（≥20s） | `qwen-audio-3.0-asr-flash` + 本地 Demucs | `vocals.wav` / `bgm.wav` / `asr.json` / `voice_samples/{speaker}.wav` |
| ③ 中→英翻译 | 逐句翻译（注入综艺口语风格）、每句 3 条备选、俚语梗标黄、**英文句长超出原句时长标红**并二选一处理、句级时间锚点可拖 | 时段路由 `qwen3.8-max`/`flash` | `translation.json` |
| ④ 音色克隆配音 | 用音色样本克隆 → 朗读确认后的英文 → 逐句配音 WAV（对齐句级锚点）；音色可来自本步克隆 / 音色库 / 克隆后入库 | `qwen-audio-3.0-tts-plus` | `dub/{line_id}.wav` + `dub_manifest.json`（相似度、时长偏差） |
| ⑤ 3D 画面重绘 | **两段式门禁**：先只重绘 1 个代表性分镜的首帧确认风格（几分钱），锁定后再逐分镜「关键帧重绘 + 图生视频动态化」全量跑 | 关键帧 `wan2.7-image-pro`，动态 `happyhorse-1.1-i2v`（无本地兜底） | `shots3d/{shot_id}.mp4` + `render_manifest.json` |
| ⑥ 口型对齐·导出 | 本地 MuseTalk 逐句驱动口型对齐英文音轨 → ffmpeg 合成（3D 画面 + 英文配音 + 背景音 ducking + 可选双语字幕）；**成片审片器**：时间轴句标记、上/下一句跳转、口型偏差报告、跳回问题句 | MuseTalk-192（本地 ¥0）+ ffmpeg | 成片 MP4 + SRT，导出到设置指定目录（默认桌面） |

每步产物都是检查点，支持断点续跑与单步重跑；4 分钟片段成本约 ¥40（⑤ 是大头）。

### 1.2 界面与运行能力

- **三个左侧菜单**：项目列表（含导入前置检查卡）· 音色库（试听/标签/被引用计数/克隆入库）· 设置（顶部 Tab 分组：云端接入、模型路由、3D 风格、翻译风格、配音参数、导出与存储、本地算力）
- **步骤工作区**统一结构：项目头 + 大号步骤条 + 左结果预览 / 右侧参数与模型卡 + 底部「上一步/下一步」
- **时段感知路由**：22:00–08:00 命中夜间 4 折时自动选高一档模型（仅作用于①③），窗口可在设置页调
- **额度与算力保护**：云端异步任务并发 ≤2（防限流）；本地 GPU 任务串行锁（同一时刻仅 1 个）
- **进度实时回流**：REST 提交任务 + SSE 推 step 状态/云端轮询进度/GPU 占用/日志尾行，界面带日志面板
- **Mock 模式**：所有云端调用返回**真实可播放/可显示**的假产物（本地 ffmpeg 生成），用于熟悉界面与验证编排，不消耗 API-KEY
- API-KEY 用 `safeStorage` 加密落盘，界面只显脱敏值，并提供连接测试

---

## 2. 技术栈

| 层 | 选型 | 版本 | 说明 |
| --- | --- | --- | --- |
| 桌面壳 | Electron | ~33.3 | 自用不分发，包体积不敏感；带托盘，关窗口 ≠ 退出 |
| 构建 | electron-vite + Vite | ~3.0 / ~5.4 | main / preload / renderer 三环境一体，渲染层 HMR |
| 语言 | TypeScript | ~5.7 | `strict` + `noImplicitAny`，禁用 `any`；两套 tsconfig（node / web） |
| UI | React | ~18.3 | 函数组件 + hooks |
| 样式 | Tailwind CSS | v4 | 设计 token 直接写在 `src/renderer/src/styles/theme.css` 的 `@theme`，颜色一律走 token、禁止硬编码 |
| 状态 | Zustand | ~5.0 | 按域切 store：app / projects / voices / workspace |
| 本地服务 | Fastify | ~5.2 | **跑在主进程内**，只监听 127.0.0.1 随机端口；REST + SSE |
| 数据库 | better-sqlite3 + drizzle-orm | ~11.8 / ~0.36 | 同步 API；schema 与迁移在 `src/main/db/` |
| 视音频 | ffmpeg-static + fluent-ffmpeg | ~5.2 / ~2.1 | ffmpeg 二进制随包分发，免安装 |
| 波形 | wavesurfer.js | ~7.8 | 音轨/配音试听；分镜条与时间轴自绘 |
| 云端 | openai SDK（兼容模式）+ 自封装 DashScope 异步任务客户端 | ~4.77 | chat/completions 走 SDK；wan / happyhorse 走提交 + 轮询 |
| 图标 | lucide-react | ~0.468 | 全站唯一图标来源，禁 emoji / icon font |
| 本地推理 | Python 3.11 + torch(CUDA 12.x) + demucs + MuseTalk | — | 独立 venv 的 sidecar 子进程，标准库 HTTP，不随包分发 |
| 打包 | electron-builder | ~25.1 | NSIS Setup + portable 双产物；`asar` + `asarUnpack` 原生模块 |
| 测试 | 自研冒烟脚本 | — | `scripts/smoke-test.mjs`（无窗口跑 ①→⑥） |

**进程边界**：渲染层永不直接触文件系统与网络 API（localhost 除外），所有副作用收敛在主进程的 server/pipeline 层；本地重推理交给 Python sidecar，主进程负责它的启停与崩溃拉起。跨层共用的类型与契约放 `src/shared/`。

---

## 3. 目录结构

```
VariDub/
├── specs/                     # SPEC-001 产品与技术规格（需求唯一来源）
├── src/
│   ├── main/                  # Electron 主进程：所有副作用都在这里
│   │   ├── index.ts           # 窗口 / 托盘 / 单实例锁 / 生命周期
│   │   ├── paths.ts           # 运行时目录、fileUrl()
│   │   ├── jobs.ts logger.ts events.ts safeStorage.ts
│   │   ├── server/            # 内嵌 Fastify（127.0.0.1 随机端口）
│   │   │   ├── app.ts         # 装配 + 静态 + streamFile()（Range 媒体流）
│   │   │   ├── dto.ts         # REST 载荷 ↔ DB 实体
│   │   │   └── routes/        # projects / content / pipeline / system
│   │   ├── pipeline/          # ★ 编排核心
│   │   │   ├── runner.ts stateMachine.ts checkpoints.ts gpuQueue.ts analyzers.ts
│   │   │   └── steps/step1.ts … step6.ts        # 六步各自实现
│   │   ├── bailian/           # 云端客户端：chat / audio / asyncTask / timeRouter / mock
│   │   ├── media/             # ffmpeg 封装（抽帧、切段、混音、字幕烧录）
│   │   ├── sidecar/           # manager.ts 启停与崩溃拉起，client.ts HTTP 客户端
│   │   ├── db/                # schema.ts / migrations.ts / repos/
│   │   └── util/              # download id json time zip
│   ├── preload/               # contextBridge：只暴露目录选择框、"在资源管理器中显示"
│   ├── renderer/src/          # React 应用
│   │   ├── api/               # client.ts（REST 封装）+ sse.ts（进度订阅）
│   │   ├── stores/            # appStore / projectsStore / voicesStore / workspaceStore
│   │   ├── pages/             # ProjectList / VoiceLibrary / Settings
│   │   │   └── pipeline/      # ProjectWorkspace + StepPane + Step1Analyze…Step6Export
│   │   ├── components/        # AppShell / Stepper / StepFooter / ui(Panel,Badge) /
│   │   │                      #   LineCard ShotCard VoiceCard WaveCard AnchorSlider
│   │   │                      #   LogPanel ModelPicker StatusChip
│   │   ├── styles/theme.css   # 设计 token 唯一来源（配色层级、控件高度、定高对齐）
│   │   └── util/              # format.ts（时间码/大小）、theme.ts（状态色映射）
│   └── shared/                # 主进程与渲染层共用：types / models / api 契约
├── sidecar/                   # Python 本地推理（独立 venv，不进 asar）
│   ├── server.py download_models.py requirements.txt requirements-cpu.txt README.md
├── resources/                 # icon.png + prompts/varidub/*.md（分镜/翻译/TTS 提示词，可编辑）
├── build/                     # icon.ico（electron-builder 的 buildResources）
├── scripts/                   # launch.ps1（启动菜单）dev.ps1 build.ps1
│                              # smoke-test.mjs setup-sidecar.ps1 run-sidecar.ps1 make-icon.mjs
├── out/                       # electron-vite 构建产物（gitignore）
├── release/                   # electron-builder 产物（gitignore）
├── 双击启动.bat                # 唯一日常入口：纯 ASCII，只转发 scripts/launch.ps1
├── electron.vite.config.ts electron-builder.yml tsconfig{,.node,.web}.json
└── package.json
```

**运行时数据目录（不在仓库内，也不随包分发）**：

| 位置 | 内容 |
| --- | --- |
| `%APPDATA%\VariDub\` | SQLite（`app.db`）、设置（含加密后的 API-KEY）、`logs\app.log` |
| `D:\Vardub_Workspace\{project_id}\` | 项目检查点：`shots/ audio/ dub/ frames/ shots3d/ final/ logs/`（工作区根目录可在设置页改） |
| `%LOCALAPPDATA%\VariDub\models\` | Demucs（~5GB）+ MuseTalk（~6.2GB）权重 |
| 导出目录 | 默认当前用户桌面，设置页可改 |

---

## 4. 启动方式

### 4.1 日常：双击根目录的 `双击启动.bat`

会弹编号菜单（含中文提示与「已在后台运行」「exe 比源码旧」等预警）：

| 编号 | 行为 |
| --- | --- |
| `[1]` 正式版 | 打开 `release\win-unpacked\VariDub.exe`，起得最快 |
| `[2]` 正式版 + Mock | 云端不发真实请求，先熟悉界面用这个 |
| `[3]` 开发模式 | 自动装依赖并 `npm run dev`，改渲染层代码即时生效 |
| `[4]` 无窗口自检 | 对打包产物跑一遍 ①→⑥ 并打印结果 |
| `[0]` 退出 | |

也可跳过菜单：`.\双击启动.bat packaged|mock|dev|smoke`。（中文都写在 `scripts/launch.ps1` 里，`.bat` 保持纯 ASCII——cmd 按字节定位行，中文和控制台代码页不一致就会错乱。）

### 4.2 开发

```powershell
npm install          # 首次；postinstall 会跑 electron-builder install-app-deps 重编译 better-sqlite3
npm run dev          # 渲染层 HMR；主进程改动需重启才生效
.\scripts\dev.ps1 -Mock -DataDir .\out\dev-data    # 带 Mock + 独立数据目录（可多实例并行）
```

### 4.3 打包

```powershell
npm run build        # 只编译到 out/
npm run dist         # electron-builder --dir，出 release/win-unpacked/VariDub.exe（调试用，快）
npm run dist:win     # 出三件套：Setup.exe + portable.exe + win-unpacked/
```

### 4.4 本地算力（要跑步骤②⑥才需要）

推荐 **设置页 → 本地算力 → 「一键准备环境（venv + 依赖）」**（主进程按 venv → 系统 Python 3.11 → 便携版 Python 顺序找解释器，建 venv、装依赖、拉模型、拉起服务，进度走 SSE 到日志面板）。命令行等价：

```powershell
npm run sidecar:install    # 建 sidecar/.venv 并装 requirements.txt（CUDA 装不上自动回退 CPU 版）
npm run sidecar:run        # 单独拉起 sidecar/server.py
sidecar\.venv\Scripts\python.exe sidecar\download_models.py --models-root "$env:LOCALAPPDATA\VariDub\models" --which demucs
```

详见 [sidecar/README.md](sidecar/README.md)。

### 4.5 环境变量

| 变量 | 作用 |
| --- | --- |
| `VARIDUB_MOCK=1` | Mock 云端；**只影响本次进程**，不写进设置库（否则下次正常启动会误以为在跑正式版） |
| `VARIDUB_DATA_DIR` | 覆盖数据目录，用于冒烟与多实例联调（同时会把 userData 指过去，绕开单实例锁） |
| `VARIDUB_MODEL_ROOT` | 覆盖本地模型目录 |
| `VARIDUB_API_KEY` | 注入 key，冒烟/CI 用，避免依赖真实凭据 |
| `VARIDUB_LIPSYNC_CMD` | 自定义口型命令模板（MuseTalk 不在 PyPI，作为可插拔后端接入） |

### 4.6 两个反复踩过的坑

1. **双击了但界面没变**：单实例锁挂在 userData 上，且点窗口 `×` 只是收进托盘 —— 旧实例会静默吃掉新启动（秒退、无日志）。先托盘图标右键「退出 VariDub」，再重开。
2. **`release\*.exe` 是打包那一刻的快照**：改完 UI 必须重跑 `npm run dist:win`，否则 `[1][2]` 看到的仍是旧界面；调 UI 建议直接用 `[3]` 开发模式。

---

## 5. 测试与自检

```powershell
npm run typecheck    # tsc --noEmit，node + web 两套工程（改任何代码后必跑）
npm run build        # 三环境构建，确认能编译产包
npm run smoke        # 冒烟：electron-vite build + 无窗口跑通 ①→⑥
```

**冒烟测试**（`scripts/smoke-test.mjs`，SPEC §7.8）验证的是「编排 + 文件产物 + 门禁」，不是模型效果：

1. 用 ffmpeg lavfi 合成 10s 样片
2. 启动无窗口 Electron（`--mock --smoke`），等 stdout 打印 `{"event":"api-ready","port":N}`
3. 依次提交并确认 ①→⑥，逐步校验落盘产物与门禁放行，最后打印每步结果与退出码

数据完全隔离在 `out/smoke/{data,workspace,export}`，不碰 `%APPDATA%\VariDub` 与真实工作区。可调环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SMOKE_EXE` | 开发态 Electron | 指向打包产物（`release\win-unpacked\VariDub.exe` 或 portable.exe）做端到端验证 |
| `SMOKE_STEP_TIMEOUT` | 300（秒） | 单步等待上限 |
| `SMOKE_VERBOSE` | 关 | 转发子进程输出 |
| `SMOKE_KEEP` | 关 | 保留上次数据目录，便于排查 |

**双态验证**：发版前开发态与打包产物各跑一遍（`npm run smoke` 与 `.\双击启动.bat smoke`），因为两者用的解释器、路径归一化与 asar 解包行为都不同。

其余约定：

- UI 改动除 typecheck/build 外，需重打 `dist:win` 并**退出旧实例**后双击查看，这是本项目唯一的验收口径
- 云端接口不写自动化用例（计费且不可控），一律用 Mock 模式覆盖；真实链路验证靠小样本项目
- `electron-builder.yml` 的 `files` 是「默认全收 + 减法排除」：量布局写的临时文件**不要落在 `out/`**，请写到仓库根 `.measure/`（已排除），否则会被打进 asar

---

## 6. 相关文档

| 文档 | 内容 |
| --- | --- |
| [specs/SPEC-001-产品与技术规格.md](specs/SPEC-001-产品与技术规格.md) | 产品定位、六步规格、模型路由与成本、架构、通信契约、设计 token 与界面还原规则 |
| [sidecar/README.md](sidecar/README.md) | Python 环境搭建、模型下载、`/health` `/separate` `/lipsync` 接口、口型可插拔后端 |
