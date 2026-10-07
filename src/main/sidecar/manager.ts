/**
 * sidecar 生命周期管理：查找/引导 Python 环境、启停进程、崩溃自动拉起一次（SPEC-001 §7.1、§7.7-4）。
 * 所有失败都带可执行提示，不静默（§8 错误可见）。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { modelsDir, ensureDir } from '../paths'
import { log, appendProjectLog } from '../logger'
import { emit } from '../events'
import { getSetting } from '../db/repos/settings'
import { downloadFile } from '../util/download'
import { unzip } from '../util/zip'
import { FFMPEG_PATH } from '../media/ffmpeg'
import { sidecar } from './client'

const PORTABLE_PYTHON_VERSION = '3.11.9'
const PORTABLE_PYTHON_URL = `https://www.python.org/ftp/python/${PORTABLE_PYTHON_VERSION}/python-${PORTABLE_PYTHON_VERSION.replace(/\./g, '')}-embed-amd64.zip`
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

export interface RuntimeStatus {
  venv: { exists: boolean; path: string; pythonPath: string | null }
  systemPython: { found: boolean; path: string | null; version: string | null }
  portable: { installed: boolean; path: string; note: string | null }
  deps: { installed: boolean; detail: string }
  models: { demucs: { available: boolean; bytes: number; dir: string }; musetalk: { available: boolean; bytes: number; dir: string } }
  server: { running: boolean; pid: number | null; port: number | null; uptimeMs: number | null; online: boolean; gpu: boolean; reason: string | null }
  sidecarDir: string
  requirementsFile: string
}

let child: ReturnType<typeof spawn> | null = null
let startedAt: number | null = null
let restarts = 0
let stopping = false
let bootNote: string | null = null
let resolving: Promise<void> | null = null

export function sidecarDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'sidecar')
  return join(app.getAppPath(), 'sidecar')
}

export function venvDir(): string {
  return join(sidecarDir(), '.venv')
}

function venvPython(): string {
  return join(venvDir(), 'Scripts', 'python.exe')
}

function portableDir(): string {
  return join(modelsDir(), '..', 'python')
}

function portablePython(): string {
  return join(portableDir(), 'python.exe')
}

function requirementsFile(): string {
  return join(sidecarDir(), 'requirements.txt')
}

function modelsRoot(): string {
  return ensureDir(modelsDir())
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  try {
    const st = statSync(dir)
    if (st.isFile()) return st.size
    return measureDir(dir, 0)
  } catch {
    return 0
  }
}

function measureDir(dir: string, depth: number): number {
  if (depth > 6) return 0
  const { readdirSync, statSync: stat } = require('node:fs') as typeof import('node:fs')
  let total = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      try {
        if (entry.isDirectory()) total += measureDir(p, depth + 1)
        else total += stat(p).size
      } catch {
        /* 忽略无法访问的条目 */
      }
    }
  } catch {
    /* 目录不可读 */
  }
  return total
}

function run(cmd: string, args: string[], opts: { cwd?: string; onLine?: (l: string) => void; timeoutMs?: number } = {}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveP) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true })
    let stderr = ''
    const rl = createInterface({ input: proc.stderr ?? process.stdin })
    rl.on('line', (line) => {
      stderr += `${line}\n`
      opts.onLine?.(line)
    })
    const rlOut = createInterface({ input: proc.stdout ?? process.stdin })
    rlOut.on('line', (line) => opts.onLine?.(line))
    proc.on('error', (err) => {
      stderr += err.message
      resolveP({ code: -1, stderr })
    })
    proc.on('close', (code) => resolveP({ code: code ?? -1, stderr }))
    if (opts.timeoutMs) setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs).unref()
  })
}

function execOut(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveP) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolveP({ code: err ? -1 : 0, stdout: stdout ?? '' })
    })
  })
}

/** 判断一个 python 可执行文件是否真实可用（排除 WindowsApps 商店占位符） */
async function validatePython(exe: string, args: string[] = []): Promise<string | null> {
  const probe = await execOut(exe, [...args, '-c', 'import sys;print(".".join(map(str, sys.version_info[:3])))'], 15_000)
  if (probe.code !== 0) return null
  const version = probe.stdout.trim().split('\n').pop() ?? ''
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null
}

async function findSystemPython(): Promise<{ path: string | null; version: string | null }> {
  const configured = getSetting('sidecar.python_path')
  if (configured && configured !== 'auto') {
    const v = await validatePython(configured)
    if (v) return { path: configured, version: v }
  }
  const candidates: Array<{ exe: string; args: string[] }> = [
    { exe: 'py', args: ['-3.11'] },
    { exe: 'py', args: ['-3'] },
    { exe: 'python', args: [] },
    { exe: 'python3', args: [] }
  ]
  // WindowsApps 商店占位符会打印提示后非 0 退出，validatePython 自然过滤掉
  for (const c of candidates) {
    const v = await validatePython(c.exe, c.args)
    if (v) {
      const where = await execOut(c.exe, [...c.args, '-c', 'import sys;print(sys.executable)'])
      const path = where.stdout.trim().split('\n').pop() ?? c.exe
      return { path, version: v }
    }
  }
  return { path: null, version: null }
}

async function depsInstalled(python: string | null): Promise<{ installed: boolean; detail: string }> {
  if (!python) return { installed: false, detail: '未找到可用 Python' }
  // server.py 本身只用标准库，重依赖是 torch + demucs（MuseTalk 按 §7.4 由用户自行 clone 仓库）
  const check = await execOut(python, ['-c', 'import torch, demucs;print(torch.__version__)'], 60_000)
  if (check.code === 0) return { installed: true, detail: `torch ${check.stdout.trim().split('\n').pop() ?? ''}` }
  const partial = await execOut(python, ['-c', 'import importlib.util as u;print(",".join(n for n in ["torch","demucs","cv2","musetalk"] if u.find_spec(n)))'], 30_000)
  return { installed: false, detail: `缺少依赖（已装：${partial.stdout.trim() || '无'}）` }
}

export async function runtimeStatus(): Promise<RuntimeStatus> {
  const venvExists = existsSync(venvPython())
  const sys = await findSystemPython()
  const portableExists = existsSync(portablePython())
  const chosen = venvExists ? venvPython() : portableExists ? portablePython() : sys.path
  const deps = await depsInstalled(chosen)
  const demucsDir = join(modelsRoot(), 'demucs')
  const musetalkDir = join(modelsRoot(), 'musetalk')
  return {
    venv: { exists: venvExists, path: venvDir(), pythonPath: venvExists ? venvPython() : null },
    systemPython: { found: !!sys.path, path: sys.path, version: sys.version },
    portable: { installed: portableExists, path: portablePython(), note: bootNote },
    deps,
    models: {
      demucs: { available: existsSync(demucsDir) && dirBytes(demucsDir) > 10_000_000, bytes: dirBytes(demucsDir), dir: demucsDir },
      musetalk: { available: existsSync(musetalkDir) && dirBytes(musetalkDir) > 10_000_000, bytes: dirBytes(musetalkDir), dir: musetalkDir }
    },
    server: {
      running: child !== null,
      pid: child?.pid ?? null,
      port: null,
      uptimeMs: startedAt ? Date.now() - startedAt : null,
      online: sidecar.status.online,
      gpu: sidecar.status.gpu,
      reason: sidecar.status.reason
    },
    sidecarDir: sidecarDir(),
    requirementsFile: requirementsFile()
  }
}

export async function resolvePythonForServer(): Promise<string | null> {
  if (existsSync(venvPython())) return venvPython()
  const portable = portablePython()
  if (existsSync(portable)) return portable
  const sys = await findSystemPython()
  return sys.path
}

/* ------------------------------------------------------------- 进程启停 */

export async function start(): Promise<void> {
  if (child) return
  if (resolving) await resolving
  const python = await resolvePythonForServer()
  if (!python) {
    const msg = '未找到可用 Python 环境（venv / 便携版 / 系统 3.11 均不存在）'
    sidecar.status = { ...sidecar.status, online: false, reason: msg }
    emit({ type: 'sidecar:status', online: false, gpu: false, reason: msg })
    throw new Error(msg)
  }
  const script = join(sidecarDir(), 'server.py')
  if (!existsSync(script)) {
    const msg = `未找到 sidecar/server.py（期望路径 ${script}）`
    emit({ type: 'sidecar:status', online: false, gpu: false, reason: msg })
    throw new Error(msg)
  }
  const port = 0
  const modelsRootPath = modelsRoot()
  log.info('sidecar', `启动：${python} server.py（models-root=${modelsRootPath}）`)
  child = spawn(python, [script, '--port', String(port), '--models-root', modelsRootPath, '--ffmpeg', FFMPEG_PATH], {
    cwd: sidecarDir(),
    windowsHide: true,
    env: { ...process.env, VARIDUB_MODEL_ROOT: modelsRootPath, VARIDUB_FFMPEG: FFMPEG_PATH, PYTHONUNBUFFERED: '1' }
  })

  await new Promise<void>((resolveP, rejectP) => {
    const timeout = setTimeout(() => rejectP(new Error('sidecar 启动超时（60s 未就绪日志）')), 60_000)
    const rl = createInterface({ input: child!.stdout ?? process.stdin })
    rl.on('line', async (line) => {
      log.info('sidecar.out', line)
      const m = /"port"\s*:\s*(\d+)/.exec(line)
      if (m && !sidecar.configured) {
        sidecar.setPort(Number(m[1]))
        try {
          await sidecar.health()
          clearTimeout(timeout)
          resolveP()
        } catch (err) {
          clearTimeout(timeout)
          rejectP(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })
    child!.on('error', (err) => {
      clearTimeout(timeout)
      rejectP(err)
    })
    child!.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0 && code !== null) rejectP(new Error(`sidecar 退出（code ${code}）`))
    })
  }).catch((err: Error) => {
    child?.kill()
    child = null
    const msg = `sidecar 启动失败：${err.message}`
    log.error('sidecar', msg)
    emit({ type: 'sidecar:status', online: false, gpu: false, reason: msg })
    throw new Error(msg)
  })

  startedAt = Date.now()
  attachSupervision()
  const status = sidecar.status
  emit({ type: 'sidecar:status', online: status.online, gpu: status.gpu, reason: status.reason })
}

function attachSupervision(): void {
  if (!child) return
  const errRl = createInterface({ input: child.stderr ?? process.stdin })
  errRl.on('line', (line) => {
    log.warn('sidecar.err', line)
    appendProjectLog(modelsRoot(), 'sidecar', line)
  })
  child.on('close', (code) => {
    child = null
    startedAt = null
    if (stopping) return
    if (restarts < 1) {
      restarts += 1
      log.warn('sidecar', `进程退出（code ${code}），自动重启一次`)
      setTimeout(() => {
        void start().catch((err: Error) => log.error('sidecar', `自动重启失败：${err.message}`))
      }, 2_000)
    } else {
      const msg = `sidecar 反复崩溃（code ${code}），已停止自动重启，请查看设置页本地算力状态`
      log.error('sidecar', msg)
      emit({ type: 'sidecar:status', online: false, gpu: false, reason: msg })
    }
  })
}

export function stop(): void {
  stopping = true
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
  child = null
  startedAt = null
  stopping = false
}

export async function ensureStarted(): Promise<void> {
  if (child && sidecar.status.online) return
  resolving = (async () => {
    try {
      await sidecar.health().catch(() => undefined)
      if (sidecar.status.online && child) return
      await start()
    } finally {
      resolving = null
    }
  })()
  await resolving
}

/* --------------------------------------------------- Python 环境一键引导 */

export interface BootstrapProgress {
  stage: string
  detail: string
  progress: number | null
}

async function emitProgress(onProgress: ((p: BootstrapProgress) => void) | null, stage: string, detail: string, progress: number | null = null): Promise<void> {
  const payload = { stage, detail, progress }
  bootNote = detail
  log.info('sidecar.bootstrap', `${stage}：${detail}`)
  onProgress?.(payload)
  emit({ type: 'log', projectId: '', line: `[本地算力引导] ${stage}：${detail}` })
}

/**
 * 引导顺序（每一步失败都给出可执行提示）：
 * 1) 优先复用系统 Python 3.11 或已有 venv；
 * 2) 否则下载便携版 Python（python.org 官方 embed）；
 * 3) 建 venv → 装 pip → pip install -r requirements.txt（CUDA 12.x torch）；
 * 4) CUDA 版失败时自动降级 CPU 版（能跑通功能，但速度/显存需按 §9 M0 实测结论决定后续路线）。
 */
export async function bootstrapPython(onProgress: ((p: BootstrapProgress) => void) | null = null): Promise<{ ok: boolean; python: string | null; detail: string }> {
  const sys = await findSystemPython()
  let python: string | null = sys.path
  let usedPortable = false
  if (existsSync(venvPython())) {
    await emitProgress(onProgress, 'venv', '已存在 sidecar/.venv，直接复用')
    return finishBootstrap(venvPython(), onProgress)
  }
  if (!python) {
    await emitProgress(onProgress, 'download', `未找到 Python，下载便携版 Python ${PORTABLE_PYTHON_VERSION}`, 0)
    const dir = portableDir()
    ensureDir(dir)
    const zip = join(dir, 'python-embed.zip')
    try {
      const res = await downloadFile(PORTABLE_PYTHON_URL, zip, (received, total) => {
        onProgress?.({ stage: 'download', detail: `下载便携版 Python：${(received / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`, progress: total ? received / total : null })
      })
      unzip(zip, dir)
      bootNote = `便携版 Python 已解包（${(res.bytes / 1024 / 1024).toFixed(1)} MB）`
      // 嵌入版默认关闭 site-packages，需放开 ._pth
      await fixEmbeddedPathFile(dir)
      await emitProgress(onProgress, 'download', '便携版 Python 就绪', 1)
      python = existsSync(portablePython()) ? portablePython() : null
      if (!python) return { ok: false, python: null, detail: '便携版 Python 解包后未找到 python.exe' }
      usedPortable = true
      await emitProgress(onProgress, 'pip', '为便携版 Python 安装 pip', null)
      const getpip = join(dir, 'get-pip.py')
      await downloadFile(GET_PIP_URL, getpip)
      const pipRes = await run(python, [getpip, '--yes'], { timeoutMs: 300_000, onLine: (l) => onProgress?.({ stage: 'pip', detail: l, progress: null }) })
      if (pipRes.code !== 0) return { ok: false, python, detail: `pip 安装失败：${pipRes.stderr.split('\n').slice(-4).join(' ')}` }
    } catch (err) {
      return { ok: false, python: null, detail: `下载失败：${err instanceof Error ? err.message : String(err)}（可改用「脚本 1」用系统 Python 建 venv）` }
    }
  } else {
    await emitProgress(onProgress, 'venv', `用系统 Python ${sys.version} 创建 venv`, 0.1)
  }

  // 嵌入版没有 venv 模块，直接把依赖装进它自己的 site-packages
  if (usedPortable) return finishBootstrap(python, onProgress)

  // 建 venv
  const venvRes = await run(python, ['-m', 'venv', venvDir()], { timeoutMs: 180_000, onLine: (l) => onProgress?.({ stage: 'venv', detail: l, progress: 0.2 }) })
  if (venvRes.code !== 0 || !existsSync(venvPython())) {
    return { ok: false, python, detail: `创建 venv 失败：${venvRes.stderr.split('\n').slice(-4).join(' ') || '未生成 Scripts/python.exe'}` }
  }
  await emitProgress(onProgress, 'venv', 'venv 已创建', 0.3)
  return finishBootstrap(venvPython(), onProgress)
}

async function finishBootstrap(python: string, onProgress: ((p: BootstrapProgress) => void) | null): Promise<{ ok: boolean; python: string; detail: string }> {
  if (!existsSync(requirementsFile())) {
    return { ok: false, python, detail: `缺少 ${requirementsFile()}` }
  }
  await emitProgress(onProgress, 'pip', '安装依赖（torch CUDA 12.1 + demucs + MuseTalk 模型库），体积较大请耐心等待', 0.35)
  const res = await run(python, ['-m', 'pip', 'install', '--no-input', '-r', requirementsFile()], {
    timeoutMs: 45 * 60_000,
    onLine: (l) => {
      if (/Requirement already satisfied|Downloading|Installing collected|Successfully installed/.test(l)) {
        onProgress?.({ stage: 'pip', detail: l.slice(0, 160), progress: null })
      }
    }
  })
  if (res.code !== 0) {
    await emitProgress(onProgress, 'pip', 'CUDA 版安装失败，尝试 CPU 版兜底', 0.7)
    const cpu = await run(python, ['-m', 'pip', 'install', '--no-input', '-r', join(sidecarDir(), 'requirements-cpu.txt')], {
      timeoutMs: 30 * 60_000,
      onLine: (l) => {
        if (/Successfully installed|ERROR/.test(l)) onProgress?.({ stage: 'pip', detail: l.slice(0, 160), progress: null })
      }
    })
    if (cpu.code !== 0) {
      return { ok: false, python, detail: `pip 安装失败：${tail(res.stderr)} / ${tail(cpu.stderr)}` }
    }
    return { ok: true, python, detail: '依赖已安装（CPU 版 torch：功能可跑通，速度按 M0 实测评估是否改用云端口型）' }
  }
  const deps = await depsInstalled(python)
  return { ok: deps.installed, python, detail: deps.detail }
}

async function fixEmbeddedPathFile(dir: string): Promise<void> {
  try {
    const { readdirSync, writeFileSync, readFileSync } = await import('node:fs')
    const pth = readdirSync(dir).find((f) => f.endsWith('._pth'))
    if (!pth) return
    const file = join(dir, pth)
    const content = readFileSync(file, 'utf8')
    if (!/^import site/m.test(content)) writeFileSync(file, `${content.trimEnd()}\nimport site\nLib\\site-packages\n`, 'utf8')
  } catch (err) {
    log.warn('sidecar', `无法调整 embedded ._pth：${err instanceof Error ? err.message : String(err)}`)
  }
}

function tail(text: string, lines = 3): string {
  return text.split('\n').filter((l) => l.trim()).slice(-lines).join(' | ').slice(0, 300)
}

export function cleanupPortable(): void {
  try {
    rmSync(portableDir(), { recursive: true, force: true })
    bootNote = '已清除便携版 Python'
  } catch (err) {
    log.warn('sidecar', `清理便携版失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

export function writeBootstrapStamp(text: string): void {
  try {
    ensureDir(sidecarDir())
    writeFileSync(join(sidecarDir(), '.bootstrap-note'), text, 'utf8')
  } catch {
    /* 仅记录用途 */
  }
}

export function readBootstrapNote(): string | null {
  if (bootNote) return bootNote
  const file = join(sidecarDir(), '.bootstrap-note')
  if (existsSync(file)) return readFileSync(file, 'utf8')
  return null
}
