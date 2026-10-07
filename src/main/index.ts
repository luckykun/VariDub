/**
 * 主进程入口（SPEC-001 §7.1 / §7.4）：窗口、托盘、内嵌服务启动、sidecar 自动拉起、断点续跑。
 * 所有业务副作用都在 server 层，这里只做生命周期编排。
 */
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, initDb } from './db'
import { Voices } from './db/repos'
import { getBool, getSetting } from './db/repos/settings'
import { PRESET_VOICES } from '../shared/models'
import { appDataDir, dbFile, ensureDir, modelsDir } from './paths'
import { log } from './logger'
import { allowRoot, startServer, type ServerHandle } from './server/app'
import { cancelJob, listJobs } from './jobs'
import { setServerPort } from './server/routes/system'
import { ensureStarted, sidecarDir, stop as stopSidecar } from './sidecar/manager'
import { resumePendingCloudTasks } from './pipeline/runner'

let mainWindow: BrowserWindow | null = null
let server: ServerHandle | null = null
let tray: Tray | null = null
let forceQuit = false

const IS_DEV = !app.isPackaged
/** 无窗口冒烟模式（scripts/smoke-test.mjs 使用，SPEC-001 §7.8） */
const SMOKE = process.argv.includes('--smoke')

app.setName('VariDub')
ensureUserDataDir()

/* ------------------------------------------------------------ 单实例 */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_evt, argv) => {
    // 又去开了另一个位置的 VariDub（旧安装包 / win-unpacked / portable 互不相同）：
    // 界面前一个实例说了算，不提醒的话就是「双击了但啥也没变」
    const other = String(argv[0] ?? '').replace(/^"|"$/g, '')
    if (other && other.toLowerCase() !== process.execPath.toLowerCase()) {
      void app.whenReady().then(() =>
        dialog
          .showMessageBox({
            type: 'warning',
            title: 'VariDub 已在运行',
            message: '你刚打开的是另一个 VariDub，界面仍由先启动的那个实例提供',
            detail: `正在运行的：${process.execPath}\n刚尝试打开的：${other}\n\n要换成后者：先退出当前实例（右下角托盘图标 → 右键「退出 VariDub」），再重新打开。`
          })
          .catch(() => undefined)
      )
    }
    showWindow()
  })
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  initDb(dbFile())
  if (process.argv.includes('--mock')) {
    // --mock 只影响本次进程（SPEC-001 §7.8）：写进设置表的话，用户下次正常启动
    // 以为自己用的是正式版，实际始终在跑 mock 假产物（真实云端永远不会被试到）
    process.env.VARIDUB_MOCK = '1'
  }
  seedPresetVoices()
  allowRoot(appDataDir())
  allowRoot(modelsDir())
  allowRoot(getSetting('storage.workspace_root'))
  const exportDir = getSetting('storage.export_dir').trim()
  if (exportDir) allowRoot(exportDir)

  server = await startServer(rendererDir())
  setServerPort(server.port)

  buildMenu()
  if (!SMOKE) {
    createWindow()
    createTray()
  } else {
    // 供冒烟脚本抓取服务地址；不开窗、不建托盘
    process.stdout.write(`${JSON.stringify({ event: 'api-ready', port: server.port, origin: server.origin, mock: true })}\n`)
  }

  // 断点续跑：先恢复已付费的云端任务，再决定是否重新提交（§7.7-1）
  void resumePendingCloudTasks()
    .then((res) => {
      if (res.checked > 0) log.info('app', `云端任务恢复检查：${res.checked} 个，续下 ${res.recovered}，失效 ${res.dropped}`)
    })
    .catch((err: Error) => log.error('app', `云端任务恢复失败：${err.message}`))

  if (!SMOKE && getBool('sidecar.auto_start')) {
    void ensureStarted()
      .then(() => log.info('app', '本地算力 sidecar 已就绪'))
      .catch((err: Error) => log.warn('app', `sidecar 未能自动启动（步骤②⑥ 会按需重试）：${err.message}`))
  }

  app.on('activate', () => showWindow())
}

/* ------------------------------------------------------------- 窗口 */

function rendererDir(): string {
  return join(__dirname, '../renderer')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1160,
    minHeight: 720,
    show: false,
    backgroundColor: '#181818',
    title: 'VariDub 综译',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [`--api-base=${server?.origin ?? ''}`, `--dev=${IS_DEV ? '1' : '0'}`]
    }
  })
  mainWindow = win
  win.on('ready-to-show', () => win.show())
  win.on('close', (e) => {
    // 有托盘时关闭 = 收进托盘，任务继续在后台跑（长任务不该被误关）
    if (!forceQuit && tray && !win.isDestroyed()) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = server?.origin ?? ''
    const devUrl = process.env['ELECTRON_RENDERER_URL'] ?? ''
    if (allowed && !url.startsWith(allowed) && !url.startsWith(devUrl)) {
      e.preventDefault()
      log.warn('app', `已阻止越界导航：${url}`)
    }
  })
  // 加载失败/渲染进程崩溃会留下白窗，没日志就无从查起（只记不弹，SSE 断开后 UI 自己会提示）
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3 || code === -102) return // 用户取消/主动中断，不是故障
    log.error('app', `界面加载失败：${url}（${code} ${desc}）`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('app', `渲染进程异常退出：${details.reason}（exit ${details.exitCode}）`)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadURL(`${server?.origin ?? 'file://'}${server ? '/' : '/index.html'}`)
  }
}

function showWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    return
  }
  createWindow()
}

function appIconPath(): string | undefined {
  const candidates = IS_DEV ? [join(app.getAppPath(), 'resources', 'icon.png')] : [join(process.resourcesPath, 'icon.png'), join(process.resourcesPath, 'resources', 'icon.png')]
  return candidates.find((p) => existsSync(p))
}

function createTray(): void {
  const icon = appIconPath()
  if (!icon) return
  const image = nativeImage.createFromPath(icon)
  if (image.isEmpty()) return
  tray = new Tray(image.resize({ width: 16, height: 16 }))
  tray.setToolTip('VariDub 综译 · 中文综艺 → 3D 动画 + 英文配音')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showWindow() },
      { label: '退出 VariDub', click: () => quitApp() }
    ])
  )
  tray.on('click', () => showWindow())
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          {
            label: '导入视频并新建项目…',
            click: () => {
              void mainWindow?.webContents.send('app:navigate', 'import')
              showWindow()
            }
          },
          { type: 'separator' },
          { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => quitApp() }
        ]
      },
      {
        label: '视图',
        submenu: [
          { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
          { label: '开发者工具', accelerator: IS_DEV ? 'Alt+Ctrl+I' : 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
          { type: 'separator' },
          { label: '窗口置于最前', click: () => showWindow() },
          { label: '最小化', accelerator: 'CmdOrCtrl+M', click: () => mainWindow?.minimize() }
        ]
      },
      {
        label: '帮助',
        submenu: [
          { label: '在资源管理器中打开 specs/', click: () => void shell.openPath(join(app.getAppPath(), 'specs')) },
          {
            label: '关于 VariDub',
            click: () =>
              dialog.showMessageBox({
                type: 'info',
                title: 'VariDub 综译',
                message: `VariDub 综译 v${app.getVersion()}`,
                detail: `Electron ${process.versions.electron} · 本地服务 ${server?.origin ?? '未启动'}\n数据目录 ${appDataDir()}\n仅供个人学习使用，请勿传播侵权内容。`
              })
          }
        ]
      }
    ])
  )
}

function quitApp(): void {
  forceQuit = true
  app.quit()
}

/* -------------------------------------------------- preload 暴露的能力 */

/** 只做原生目录/文件选择与「在资源管理器中显示」（SPEC-001 §7.5 IPC 契约） */
ipcMain.handle('dialog:pick', async (evt, args: { kind?: string; title?: string; multi?: boolean }) => {
  const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined
  const kind = args.kind ?? 'file'
  const properties: Array<'openFile' | 'openDirectory' | 'createDirectory' | 'multiSelections'> =
    kind === 'directory' ? ['openDirectory', 'createDirectory'] : args.multi ? ['openFile', 'multiSelections'] : ['openFile']
  const filters =
    kind === 'video'
      ? [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
      : kind === 'audio'
        ? [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac'] }]
        : [{ name: '所有文件', extensions: ['*'] }]
  const options: Electron.OpenDialogOptions = { title: args.title, properties, filters }
  const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return res.canceled ? { path: null, paths: [] as string[] } : { path: res.filePaths[0] ?? null, paths: res.filePaths }
})

ipcMain.on('shell:reveal', (_evt, path: string) => {
  if (typeof path === 'string' && path) shell.showItemInFolder(path)
})

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron ?? '',
  platform: process.platform,
  appDataDir: appDataDir(),
  sidecarDir: sidecarDir(),
  apiBase: server?.origin ?? ''
}))

/* -------------------------------------------------------------- 生命周期 */

app.on('window-all-closed', () => {
  quitApp()
})

app.on('before-quit', () => {
  forceQuit = true
  // 进行中的任务置为取消，避免重启后出现孤儿 running 状态
  for (const job of listJobs().filter((j) => j.state === 'running' || j.state === 'queued')) cancelJob(job.id)
  stopSidecar()
  void server?.close()
  closeDb()
})

app.on('child-process-gone', (_e, details) => {
  if (details.type === 'Utility' || /GPU/i.test(details.reason)) log.warn('app', `子进程异常退出：${details.type} ${details.reason}`)
})

process.on('unhandledRejection', (reason) => log.error('app', `未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`))
process.on('uncaughtException', (err) => log.error('app', `未捕获异常：${err.stack ?? err.message}`))

/* -------------------------------------------------------------- 内部工具 */

function ensureUserDataDir(): void {
  // 数据目录默认 %APPDATA%/VariDub，避免与默认「按应用名」路径混淆（§7.4）
  try {
    const dir = appDataDir()
    // 单实例锁与 Chromium 缓存都挂在 userData 上：只改 appDataDir() 的话，
    // 第二个实例（冒烟/多实例联调）会被锁掉，表现为开起来就秒退且无任何日志
    if (process.env.VARIDUB_DATA_DIR?.trim()) app.setPath('userData', dir)
    ensureDir(join(dir, 'logs'))
    ensureDir(modelsDir())
  } catch (err) {
    log.error('app', `数据目录初始化失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 音色库首次使用时写入预置音色（§3.4 音色来源 ②） */
function seedPresetVoices(): void {
  try {
    const existing = new Set(Voices.list().map((v) => `${v.sourceType}:${v.name}`))
    for (const preset of PRESET_VOICES) {
      if (existing.has(`preset:${preset.name}`)) continue
      Voices.create({ name: preset.name, sourceType: 'preset', tags: [...preset.tags], durationMs: null })
    }
  } catch (err) {
    log.error('app', `预置音色写入失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
