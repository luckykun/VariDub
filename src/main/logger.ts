/** 日志：应用级 %APPDATA%/VariDub/logs/app.log + 项目级 <workspace>/<id>/logs/（SPEC-001 §7.7-3） */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appDataDir } from './paths'

const APP_LOG_LIMIT = 4 * 1024 * 1024

export function appLogFile(): string {
  return join(appDataDir(), 'logs', 'app.log')
}

function writeAppLog(level: string, scope: string, msg: string): void {
  const file = appLogFile()
  try {
    if (existsSync(file) && statSync(file).size > APP_LOG_LIMIT) truncateSync(file, 0)
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${scope}: ${msg}\n`, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
  const line = `${new Date().toISOString().slice(11, 23)} [${level}] ${scope}: ${msg}`
  if (level === 'ERROR') console.error(line)
  else console.log(line)
}

export const log = {
  info: (scope: string, msg: string): void => writeAppLog('INFO', scope, msg),
  warn: (scope: string, msg: string): void => writeAppLog('WARN', scope, msg),
  error: (scope: string, msg: string): void => writeAppLog('ERROR', scope, msg)
}

export function projectLogDir(workspaceDir: string): string {
  const dir = join(workspaceDir, 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 本地任务（Demucs / MuseTalk）日志写项目目录，UI 查看尾 200 行 */
export function appendProjectLog(workspaceDir: string, name: string, chunk: string): string | null {
  if (!workspaceDir) return null
  try {
    const file = join(projectLogDir(workspaceDir), `${name}.log`)
    appendFileSync(file, chunk.endsWith('\n') ? chunk : `${chunk}\n`, 'utf8')
    return file
  } catch {
    return null
  }
}

export function projectLogFile(workspaceDir: string, name: string): string {
  return join(projectLogDir(workspaceDir), `${name}.log`)
}

export function readLogTail(file: string, lines = 200): { file: string; exists: boolean; text: string } {
  if (!file || !existsSync(file)) return { file, exists: false, text: '' }
  const size = statSync(file).size
  const fd = readFileSync(file)
  const from = Math.max(0, size - 256 * 1024)
  const text = fd.subarray(from).toString('utf8').split('\n').slice(-lines).join('\n')
  return { file, exists: true, text }
}

export function ensureParent(file: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
