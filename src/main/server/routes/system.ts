/**
 * 系统类接口（SPEC-001 §6 设置、§5 模型目录、§7.1 本地算力、§7.5 文件与日志、§7.9 密钥）。
 * 目录选择走 Electron dialog（由主进程执行，渲染层通过 preload 或本接口调用）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, dialog, app } from 'electron'
import type { FastifyInstance } from 'fastify'
import type { SettingsDto } from '../../../shared/types'
import type { LogResponse, ModelCatalogDto, PickRequest, PickResponse, SettingsResponse, SystemInfoDto } from '../../../shared/api'
import { MODELS, STYLE_PRESETS, STAGE_OPTIONS, LOCAL_MODELS, PRESET_VOICES } from '../../../shared/models'
import { getSetting } from '../../db/repos/settings'
import { Projects } from '../../db/repos'
import { appDataDir, modelsDir } from '../../paths'
import { log, readLogTail } from '../../logger'
import { emit } from '../../events'
import { secretState } from '../../safeStorage'
import { mockMode, testConnection } from '../../bailian/chat'
import { FFMPEG_PATH } from '../../media/ffmpeg'
import { sidecar } from '../../sidecar/client'
import { bootstrapPython, ensureStarted, readBootstrapNote, runtimeStatus, stop as stopSidecar, writeBootstrapStamp } from '../../sidecar/manager'
import { projectPaths } from '../../pipeline/paths'
import { GateError } from '../../pipeline/runner'
import { allowRoot, isReadable, streamFile } from '../app'
import { applySettingsPatch, defaultExportDir, modelRoutes, refreshFreeBytes, saveApiKey, settingsDto, sidecarView } from '../dto'

/** 主进程启动服务后回填，供 /api/system 展示 */
let serverPort = 0

export function setServerPort(port: number): void {
  serverPort = port
}

export function registerSystemRoutes(app2: FastifyInstance): void {
  /* -------------------------------------------------------------- 设置 */

  app2.get('/api/settings', async (): Promise<SettingsResponse> => {
    await refreshFreeBytes()
    return { settings: settingsDto(), routes: modelRoutes(), secret: secretState() }
  })

  app2.patch('/api/settings', async (req): Promise<SettingsResponse> => {
    const patch = (req.body ?? {}) as Partial<SettingsDto>
    await refreshFreeBytes()
    const settings = applySettingsPatch(patch)
    if (patch.storage?.workspaceRoot) ensureWorkspaceRoot(patch.storage.workspaceRoot)
    emit({ type: 'settings:update' })
    return { settings, routes: modelRoutes(), secret: secretState() }
  })

  app2.post('/api/settings/api-key', async (req) => {
    const body = (req.body ?? {}) as { key?: string }
    const key = (body.key ?? '').trim()
    if (!key) throw new GateError('API-KEY 为空')
    try {
      const settings = saveApiKey(key)
      emit({ type: 'settings:update' })
      return { ok: true, masked: settings.api.keyMasked, hasKey: settings.api.hasKey }
    } catch (err) {
      throw new GateError(err instanceof Error ? err.message : String(err))
    }
  })

  app2.delete('/api/settings/api-key', async () => {
    const settings = saveApiKey('')
    emit({ type: 'settings:update' })
    return { ok: true, hasKey: settings.api.hasKey }
  })

  app2.post('/api/settings/test-connection', async () => {
    const result = await testConnection()
    log.info('settings', `连通性测试：${result.ok ? '通过' : '失败'} — ${result.detail}`)
    return result
  })

  /* ---------------------------------------------------------- 模型目录 */

  app2.get('/api/models', async (): Promise<ModelCatalogDto> => {
    return {
      models: Object.values(MODELS).map((m) => ({
        id: m.id,
        label: m.label,
        kind: m.kind,
        note: m.note,
        nightDiscount: m.nightDiscount,
        timeAwareEligible: m.timeAwareEligible,
        unavailable: m.unavailable,
        noLocalFallback: m.noLocalFallback
      })),
      stageOptions: STAGE_OPTIONS,
      styles: STYLE_PRESETS.map((s) => ({ id: s.id, label: s.label, desc: s.desc })),
      presetVoices: PRESET_VOICES.map((v) => ({ name: v.name, tags: v.tags, desc: v.desc })),
      localModels: Object.entries(LOCAL_MODELS).map(([key, v]) => ({ key, label: v.label, usage: v.usage, cost: v.cost })),
      routes: modelRoutes(),
      mockMode: mockMode()
    }
  })

  /* ------------------------------------------------------------ sidecar */

  app2.get('/api/sidecar', async () => {
    const runtime = await runtimeStatus()
    return { view: sidecarView(), runtime, bootstrapNote: readBootstrapNote() }
  })

  app2.post('/api/sidecar/start', async () => {
    try {
      await ensureStarted()
      const status = await sidecar.health()
      emit({ type: 'sidecar:status', online: status.online, gpu: status.gpu, reason: null })
      return { ok: true, view: sidecarView() }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: 'sidecar:status', online: false, gpu: false, reason: message })
      throw new GateError(message)
    }
  })

  app2.post('/api/sidecar/stop', async () => {
    stopSidecar()
    sidecar.status = { ...sidecar.status, online: false, gpu: false, reason: '已手动停止' }
    emit({ type: 'sidecar:status', online: false, gpu: false, reason: '已手动停止' })
    return { ok: true }
  })

  /** Python 环境一键引导（进度经 SSE 的 log 事件推送，SPEC-001 §7.1） */
  app2.post('/api/sidecar/bootstrap', async (req) => {
    const body = (req.body ?? {}) as { silent?: boolean }
    const onProgress = body.silent === false ? null : progressReporter()
    const result = await bootstrapPython(onProgress)
    writeBootstrapStamp(result.detail)
    await refreshFreeBytes()
    emit({ type: 'settings:update' })
    return { ok: result.ok, python: result.python, detail: result.detail, view: sidecarView() }
  })

  app2.post('/api/sidecar/models/download', async (req) => {
    const body = (req.body ?? {}) as { which?: 'demucs' | 'musetalk' | 'all' }
    const which = body.which ?? 'all'
    try {
      await ensureStarted()
      const res = await sidecar.downloadModels(which)
      return { ok: true, result: res, view: sidecarView() }
    } catch (err) {
      throw new GateError(err instanceof Error ? err.message : String(err))
    }
  })

  app2.get('/api/sidecar/models/jobs', async () => {
    try {
      return { jobs: await sidecar.modelsJobs(), view: sidecarView() }
    } catch (err) {
      return { jobs: [], error: err instanceof Error ? err.message : String(err), view: sidecarView() }
    }
  })

  app2.get('/api/sidecar/status', async () => {
    try {
      await sidecar.health()
    } catch {
      /* 未启动时保持现有 status */
    }
    return sidecarView()
  })

  /* -------------------------------------------------------- 文件与日志 */

  app2.get('/api/files', (req, reply) => {
    const query = req.query as { p?: string; download?: string }
    // Fastify 已经解过一层 query，不能再 decodeURIComponent：路径里带 % 的文件（如「50%完成.mp4」）会被二次解码报 URIError
    const target = query.p ?? ''
    if (!target) return reply.status(400).send({ error: '缺少文件参数 p' })
    if (!isReadable(target)) return reply.status(403).send({ error: '该路径不在允许读取的目录内（项目工作区 / 源视频目录 / 导出目录）' })
    // 必须 return：流式响应被 await 吃掉就会变成「headers 对、body 0 字节」（详见 streamFile 注释）
    return streamFile(req, reply, target, query.download === '1')
  })

  app2.get('/api/logs', async (req): Promise<LogResponse> => {
    const query = req.query as { projectId?: string; name?: string; tail?: string; app?: string }
    const tail = Math.max(20, Math.min(2000, Number(query.tail ?? 200) || 200))
    const name = (query.name ?? '').replace(/[^\w.-]/g, '')
    if (query.app === '1') {
      return readLogTail(join(appDataDir(), 'logs', 'app.log'), tail)
    }
    const project = query.projectId ? Projects.get(query.projectId) : null
    if (!project) throw new GateError('项目不存在')
    if (!name) throw new GateError('缺少日志名（step1…step6 / demucs / musetalk）')
    allowRoot(project.workspaceDir)
    const file = projectPaths(project.id).log(name)
    return { ...readLogTail(file, tail), file, exists: existsSync(file) }
  })

  app2.get('/api/logs/available', async (req) => {
    const id = (req.query as { projectId?: string }).projectId ?? ''
    const project = Projects.get(id)
    if (!project) throw new GateError('项目不存在')
    const paths = projectPaths(project.id)
    const names = ['step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'demucs', 'musetalk', 'sidecar']
    return { files: names.map((n) => ({ name: n, path: paths.log(n), exists: existsSync(paths.log(n)) })) }
  })

  /* ------------------------------------------------------------ 应用信息 */

  app2.get('/api/system', async (): Promise<SystemInfoDto> => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    platform: process.platform,
    mockMode: mockMode(),
    hasApiKey: secretState().hasKey,
    appDataDir: appDataDir(),
    workspaceRoot: getSetting('storage.workspace_root'),
    exportDir: getSetting('storage.export_dir').trim() || defaultExportDir(),
    serverPort,
    ffmpeg: FFMPEG_PATH,
    modelsDir: modelsDir()
  }))

  /* -------------------------------------------------------- 目录/文件选择 */

  app2.post('/api/pick', async (req): Promise<PickResponse> => {
    const body = (req.body ?? {}) as PickRequest
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const kind = body.kind ?? 'file'
    const options: Electron.OpenDialogOptions = {
      title: body.title ?? defaultPickTitle(kind),
      properties: kind === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'],
      filters: filtersFor(kind)
    }
    const res = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    if (res.canceled || res.filePaths.length === 0) return { path: null, paths: [] }
    const picked = res.filePaths[0]
    allowRoot(kind === 'directory' ? picked : join(picked, '..'))
    return { path: picked, paths: res.filePaths }
  })

  app2.post('/api/reveal', async (req) => {
    const body = (req.body ?? {}) as { path?: string }
    const target = (body.path ?? '').trim()
    if (!target) throw new GateError('没有路径')
    if (!existsSync(target)) throw new GateError(`文件不存在：${target}`)
    const { shell } = await import('electron')
    shell.showItemInFolder(target)
    return { ok: true }
  })
}

function defaultPickTitle(kind: PickRequest['kind']): string {
  if (kind === 'directory') return '选择文件夹'
  if (kind === 'video') return '选择视频文件'
  if (kind === 'audio') return '选择音频样本（WAV）'
  return '选择文件'
}

function filtersFor(kind: PickRequest['kind']): Electron.FileFilter[] {
  if (kind === 'video') return [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
  if (kind === 'audio') return [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac'] }]
  return [{ name: '所有文件', extensions: ['*'] }]
}

function ensureWorkspaceRoot(dir: string): void {
  try {
    allowRoot(dir)
  } catch (err) {
    log.warn('settings', `工作区目录不可用 ${dir}：${err instanceof Error ? err.message : String(err)}`)
  }
}

function progressReporter(): (p: { stage: string; detail: string; progress: number | null }) => void {
  return (p) => {
    emit({ type: 'log', projectId: '', line: `[本地算力引导 ${p.stage}] ${p.detail}${p.progress !== null ? `（${Math.round(p.progress * 100)}%）` : ''}` })
  }
}
