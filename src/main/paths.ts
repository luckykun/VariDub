/** 跨层共用的运行时路径与常量（SPEC-001 §7.4 运行时数据目录） */
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 应用配置目录：%APPDATA%/VariDub —— SQLite、设置、日志 */
export function appDataDir(): string {
  // 冒烟测试与多实例联调用 VARIDUB_DATA_DIR 隔离，不污染真实库（SPEC-001 §7.8）
  const override = process.env.VARIDUB_DATA_DIR?.trim()
  if (override) return ensureDir(override)
  const dir = join(app.getPath('appData'), 'VariDub')
  ensureDir(dir)
  return dir
}

/** 本地模型目录：%LOCALAPPDATA%/VariDub/models */
export function modelsDir(): string {
  const override = process.env.VARIDUB_MODEL_ROOT?.trim()
  if (override) return ensureDir(override)
  const base = process.env.LOCALAPPDATA ?? app.getPath('appData')
  const dir = join(base, 'VariDub', 'models')
  ensureDir(dir)
  return dir
}

export function dbFile(): string {
  return join(appDataDir(), 'app.db')
}

export function appLogFile(): string {
  return join(appDataDir(), 'logs', 'app.log')
}

export function promptsDir(): string {
  // 打包后 resources/prompts，开发时仓库根 resources/prompts
  if (app.isPackaged) return join(process.resourcesPath, 'prompts')
  return join(app.getAppPath(), 'resources', 'prompts')
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function ensureProjectDir(root: string, projectId: string): string {
  const dir = join(root, projectId)
  for (const sub of ['', 'shots', 'audio', 'audio/voice_samples', 'dub', 'frames', 'shots3d', 'final', 'logs']) {
    ensureDir(sub ? join(dir, sub) : dir)
  }
  return dir
}

/** 视频/图片文件的服务端可读 URL（走 /api/files） */
export function fileUrl(absPath: string): string {
  return `/api/files?p=${encodeURIComponent(absPath)}`
}
