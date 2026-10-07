/**
 * 渲染层唯一的数据出口（SPEC-001 §7.5）：全部走主进程内嵌 Fastify 的 /api/*。
 * 渲染层不碰文件系统；目录选择经 preload 桥接（原生对话框），其余都是 HTTP。
 */
import type {
  ArtifactDto,
  JobDto,
  LineDto,
  OverflowPolicy,
  PrecheckResult,
  ProjectDto,
  SettingsDto,
  ShotDto,
  SpeakerDto,
  StepId,
  VoiceDto
} from '@shared/types'
import type {
  AppInfoDto,
  ConfirmResponse,
  FinalProductDto,
  GateIssue,
  LinePatchRequest,
  LogResponse,
  ModelCatalogDto,
  OverviewDto,
  PickResponse,
  ReportDto,
  SettingsResponse,
  ShotPatchRequest,
  SidecarViewDto,
  SpeakerPatchRequest,
  StepRunRequest,
  SystemInfoDto,
  VoiceCreateRequest
} from '@shared/api'

const bridge = typeof window === 'undefined' ? undefined : window.varidub

/** dev 时渲染层在 vite 端口，必须用桥接给出的主进程地址；打包后同源即可 */
export const API_BASE = (bridge?.apiBase || (typeof window === 'undefined' ? '' : window.location.origin)).replace(/\/$/, '')

/** 本地文件 → 可读 URL（<video>/<img>/<audio> 都用它） */
export function fileUrl(path: string | null | undefined): string {
  return path ? `${API_BASE}/api/files?p=${encodeURIComponent(path)}` : ''
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  })
  const text = await res.text()
  const payload: unknown = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : `HTTP ${res.status}`
    throw new Error(message)
  }
  return payload as T
}

const get = <T>(path: string): Promise<T> => request<T>(path)
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const patch = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
const del = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  projects: {
    list: (): Promise<ProjectDto[]> => get('/api/projects'),
    create: (filePath: string, name?: string): Promise<ProjectDto> => post('/api/projects', { filePath, name }),
    precheck: (filePath: string): Promise<PrecheckResult> => post('/api/precheck', { filePath }),
    get: (id: string): Promise<ProjectDto> => get(`/api/projects/${id}`),
    overview: (id: string): Promise<OverviewDto> => get(`/api/projects/${id}/overview`),
    rename: (id: string, name: string): Promise<ProjectDto> => patch(`/api/projects/${id}`, { name }),
    remove: (id: string, purgeFiles: boolean): Promise<{ ok: boolean; purged: boolean }> => del(`/api/projects/${id}`, { purgeFiles }),
    report: (id: string): Promise<ReportDto & { product: FinalProductDto | null }> => get(`/api/projects/${id}/report`),
    artifacts: (id: string, step?: StepId): Promise<ArtifactDto[]> => get(`/api/projects/${id}/artifacts${step ? `?step=${step}` : ''}`)
  },

  pipeline: {
    run: (id: string, step: StepId, body: StepRunRequest = {}): Promise<JobDto> => post(`/api/projects/${id}/steps/${step}/run`, body),
    gate: (id: string, step: StepId): Promise<{ allowed: boolean; reason: string | null; issues: GateIssue[]; blocking: string[] }> =>
      get(`/api/projects/${id}/steps/${step}/gate`),
    confirm: (id: string, step: StepId, force = false): Promise<ConfirmResponse> => post(`/api/projects/${id}/steps/${step}/confirm`, { force }),
    reopen: (id: string, step: StepId): Promise<ProjectDto> => post(`/api/projects/${id}/steps/${step}/reopen`),
    jobs: (id: string): Promise<JobDto[]> => get(`/api/projects/${id}/jobs`),
    cancel: (id: string, jobId: string): Promise<{ ok: boolean; job: JobDto }> => post(`/api/projects/${id}/jobs/${jobId}/cancel`),
    pilot: (id: string, body: StepRunRequest & { shotId?: string | null }): Promise<JobDto> => post(`/api/projects/${id}/step5/pilot`, body),
    rerunShots: (id: string, shotIds: string[], body: StepRunRequest = {}): Promise<JobDto> => post(`/api/projects/${id}/step5/shots`, { shotIds, ...body }),
    rerunLow: (id: string, threshold?: number): Promise<JobDto> => post(`/api/projects/${id}/step5/rerun-low`, { threshold }),
    accept: (id: string, shotIds?: string[]): Promise<{ accepted: number; shots: ShotDto[] }> => post(`/api/projects/${id}/shots/accept`, { shotIds }),
    exportFinal: (id: string, body: { destDir?: string; name?: string | null }): Promise<{ exportedTo: string; product: FinalProductDto | null }> =>
      post(`/api/projects/${id}/step6/export`, body),
    lineAction: (lineId: string, action: 'translate' | 'alts' | 'dub'): Promise<JobDto> => post(`/api/lines/${lineId}/action`, { action })
  },

  shots: {
    list: (id: string): Promise<ShotDto[]> => get(`/api/projects/${id}/shots`),
    patch: (shotId: string, body: ShotPatchRequest): Promise<ShotDto> => patch(`/api/shots/${shotId}`, body),
    split: (id: string, shotId: string, atMs: number): Promise<ShotDto[]> => post(`/api/projects/${id}/shots/split`, { shotId, atMs }),
    merge: (id: string, shotId: string): Promise<ShotDto[]> => post(`/api/projects/${id}/shots/merge`, { shotId }),
    remove: (shotId: string): Promise<{ ok: boolean; shots: ShotDto[] }> => del(`/api/shots/${shotId}`)
  },

  lines: {
    list: (id: string): Promise<LineDto[]> => get(`/api/projects/${id}/lines`),
    patch: (lineId: string, body: LinePatchRequest): Promise<LineDto> => patch(`/api/lines/${lineId}`, body),
    confirm: (lineId: string, confirmed: boolean): Promise<{ ok: boolean; line: LineDto }> => post(`/api/lines/${lineId}/confirm`, { confirmed }),
    confirmAll: (id: string): Promise<{ confirmed: number; lines: LineDto[] }> => post(`/api/projects/${id}/lines/confirm-all`),
    setOverflowPolicy: (lineId: string, policy: OverflowPolicy): Promise<LineDto> => patch(`/api/lines/${lineId}`, { overflowPolicy: policy })
  },

  speakers: {
    list: (id: string): Promise<SpeakerDto[]> => get(`/api/projects/${id}/speakers`),
    patch: (speakerId: string, body: SpeakerPatchRequest): Promise<SpeakerDto> => patch(`/api/speakers/${speakerId}`, body),
    resample: (speakerId: string, startMs: number, endMs: number): Promise<SpeakerDto> => post(`/api/speakers/${speakerId}/resample`, { startMs, endMs })
  },

  voices: {
    list: (kind: 'all' | 'cloned' | 'preset' = 'all'): Promise<VoiceDto[]> => get(`/api/voices?kind=${kind}`),
    create: (body: VoiceCreateRequest): Promise<VoiceDto> => post('/api/voices', body),
    patch: (id: string, body: { name?: string; tags?: string[] }): Promise<VoiceDto | null> => patch(`/api/voices/${id}`, body),
    remove: (id: string): Promise<{ ok: boolean }> => del(`/api/voices/${id}`),
    preview: (id: string, text?: string): Promise<{ path: string; exists: boolean }> => post(`/api/voices/${id}/preview`, { text })
  },

  settings: {
    get: (): Promise<SettingsResponse> => get('/api/settings'),
    patch: (body: Partial<SettingsDto>): Promise<SettingsResponse> => patch('/api/settings', body),
    saveApiKey: (key: string): Promise<{ ok: boolean; masked: string | null; hasKey: boolean }> => post('/api/settings/api-key', { key }),
    clearApiKey: (): Promise<{ ok: boolean; hasKey: boolean }> => del('/api/settings/api-key'),
    testConnection: (): Promise<{ ok: boolean; detail: string }> => post('/api/settings/test-connection')
  },

  models: {
    catalog: (): Promise<ModelCatalogDto> => get('/api/models')
  },

  sidecar: {
    view: (): Promise<SidecarViewDto> => get('/api/sidecar/status'),
    detail: (): Promise<{ view: SidecarViewDto; runtime: unknown; bootstrapNote: string | null }> => get('/api/sidecar'),
    start: (): Promise<{ ok: boolean; view: SidecarViewDto }> => post('/api/sidecar/start'),
    stop: (): Promise<{ ok: boolean }> => post('/api/sidecar/stop'),
    bootstrap: (): Promise<{ ok: boolean; python: string | null; detail: string; view: SidecarViewDto }> => post('/api/sidecar/bootstrap'),
    downloadModels: (which: 'demucs' | 'musetalk' | 'all'): Promise<{ ok: boolean; view: SidecarViewDto }> => post('/api/sidecar/models/download', { which }),
    modelJobs: (): Promise<{ jobs: Array<{ id: string; which: string; status: string; message: string; error: string | null; logs: string[] }> }> =>
      get('/api/sidecar/models/jobs')
  },

  system: {
    info: (): Promise<SystemInfoDto> => get('/api/system'),
    logs: (projectId: string, name: string, tail = 200): Promise<LogResponse> => get(`/api/logs?projectId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}&tail=${tail}`),
    appLog: (tail = 200): Promise<LogResponse> => get(`/api/logs?app=1&tail=${tail}`),
    logFiles: (projectId: string): Promise<{ files: Array<{ name: string; path: string; exists: boolean }> }> => get(`/api/logs/available?projectId=${encodeURIComponent(projectId)}`),
    /** 原生目录/文件选择：优先走 preload 桥接（真原生对话框），浏览器直开时退回主进程接口 */
    async pick(kind: 'video' | 'directory' | 'audio' | 'file', opts: { title?: string; multi?: boolean } = {}): Promise<PickResponse> {
      if (bridge?.pick) return bridge.pick(kind, opts)
      return post('/api/pick', { kind, title: opts.title })
    },
    reveal(path: string): void {
      if (bridge?.reveal) {
        bridge.reveal(path)
        return
      }
      void post('/api/reveal', { path })
    },
    appInfo: (): Promise<AppInfoDto | null> => (bridge?.info ? bridge.info() : Promise.resolve(null))
  }
}
