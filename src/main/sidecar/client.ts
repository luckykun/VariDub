/**
 * Python sidecar HTTP 客户端（SPEC-001 §7.5：主进程 → 127.0.0.1:{随机端口}）。
 * /separate（Demucs）、/lipsync（MuseTalk）、/health。GPU 任务在 sidecar 内也排队，
 * 本进程的串行锁（gpuQueue）保证同一时刻只提交一个。
 */
import { log } from '../logger'

export interface SidecarStatus {
  online: boolean
  gpu: boolean
  device: string | null
  torch: string | null
  models: { demucs: boolean; musetalk: boolean }
  version: string
  reason: string | null
  /** 已发现但版本/配置不符 */
  mismatch: string | null
}

export class SidecarError extends Error {
  hint: string | null
  constructor(message: string, hint: string | null = null) {
    super(message)
    this.name = 'SidecarError'
    this.hint = hint
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class SidecarClient {
  private baseUrl = ''
  status: SidecarStatus = {
    online: false,
    gpu: false,
    device: null,
    torch: null,
    models: { demucs: false, musetalk: false },
    version: '',
    reason: '未启动',
    mismatch: null
  }

  setPort(port: number): void {
    this.baseUrl = `http://127.0.0.1:${port}`
  }

  get configured(): boolean {
    return this.baseUrl !== ''
  }

  private async request<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
    if (!this.baseUrl) throw new SidecarError('sidecar 未启动', '到「设置 → 本地算力」一键启动，或手动运行 npm run sidecar:run')
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      const text = await res.text()
      if (!res.ok) throw new SidecarError(`sidecar ${path} 返回 HTTP ${res.status}：${text.slice(0, 300)}`)
      return JSON.parse(text) as T
    } catch (err) {
      if (err instanceof SidecarError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new SidecarError(`sidecar ${path} 调用失败：${msg}`, msg.includes('timed out') ? '任务超时，可在侧栏查看日志' : null)
    }
  }

  async health(): Promise<SidecarStatus> {
    try {
      const data = await this.request<Partial<SidecarStatus> & { models?: { demucs?: boolean; musetalk?: boolean } }>('/health', undefined, 8_000)
      this.status = {
        online: true,
        gpu: !!data.gpu,
        device: data.device ?? null,
        torch: data.torch ?? null,
        models: { demucs: !!data.models?.demucs, musetalk: !!data.models?.musetalk },
        version: data.version ?? '',
        reason: null,
        mismatch: data.reason ?? null
      }
      return this.status
    } catch (err) {
      this.status = { ...this.status, online: false, reason: err instanceof Error ? err.message : String(err) }
      throw err
    }
  }

  /**
   * 提交长任务：POST 返回 queued + job_id，然后轮询 /job/<id>。
   * onLine 收到 job 日志尾行，便于写入项目日志目录。
   */
  private async submitAndWait<T>(path: string, body: unknown, opts: { onLine?: (line: string) => void; timeoutMs?: number; label: string }): Promise<T> {
    const first = await this.request<Record<string, unknown>>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, 60_000)
    const jobId = first.job_id
    if (typeof jobId !== 'string') {
      // 同步返回（例如 tiny 输入）
      return first as unknown as T
    }
    const started = Date.now()
    let cursor = 0
    let logged = ''
    for (;;) {
      await sleep(3_000)
      const job = await this.request<Record<string, unknown>>(`/job/${encodeURIComponent(String(jobId))}`, undefined, 20_000)
      const logs = job.logs
      if (Array.isArray(logs) && logs.length > cursor) {
        for (const line of logs.slice(cursor)) {
          const text = String(line)
          logged += `${text}\n`
          opts.onLine?.(text)
        }
        cursor = logs.length
      }
      const status = String(job.status ?? '')
      if (status === 'done') {
        opts.onLine?.(logged)
        return ((job.result ?? {}) as T) ?? ({} as T)
      }
      if (status === 'error') {
        const error = String(job.error ?? '未知错误')
        log.error('sidecar', `${opts.label} 失败：${error}`)
        throw new SidecarError(`${opts.label} 失败：${error}`, /cuda|oom|显存/i.test(error) ? '显存不足或 CUDA 不可用：见 §9 M0 硬前置，需确认 1660 Ti 实测表现' : null)
      }
      if (Date.now() - started > (opts.timeoutMs ?? 30 * 60_000)) {
        throw new SidecarError(`${opts.label} 超时（>${Math.round((opts.timeoutMs ?? 1_800_000) / 60_000)} 分钟）`)
      }
      opts.onLine?.(String(job.message ?? `状态 ${status || 'queued'}`))
    }
  }

  /** Demucs 人声分离：返回 vocals / background 两轨绝对路径 */
  async separate(input: string, outDir: string, opts: { twoStem?: boolean; mp3?: boolean; onLine?: (l: string) => void } = {}): Promise<{ vocals: string; bgm: string; time_s?: number }> {
    const result = await this.submitAndWait<{ vocals?: string; background?: string; bgm?: string; time_s?: number }>(
      '/separate',
      { input, out_dir: outDir, two_stem: opts.twoStem ?? true, mp3: opts.mp3 ?? false, model: 'htdemucs' },
      { label: 'Demucs 人声分离', onLine: opts.onLine, timeoutMs: 30 * 60_000 }
    )
    if (!result.vocals) throw new SidecarError('Demucs 未返回人声轨路径')
    return { vocals: result.vocals, bgm: result.background ?? result.bgm ?? '', time_s: result.time_s }
  }

  /** MuseTalk 口型对齐：返回视频路径与检测到的嘴部中心偏移（ms） */
  async lipsync(params: {
    video: string
    audio: string
    out: string
    box?: [number, number, number, number]
    fps?: number
    onLine?: (l: string) => void
  }): Promise<{ video: string; offset_ms?: number; offset_frames?: number; width?: number; height?: number }> {
    return this.submitAndWait(
      '/lipsync',
      {
        video: params.video,
        audio: params.audio,
        out: params.out,
        box: params.box,
        fps: params.fps ?? 30,
        width: 192,
        height: 192
      },
      { label: 'MuseTalk 口型对齐', onLine: params.onLine, timeoutMs: 60 * 60_000 }
    )
  }

  /** 嘴部定位（可插拔视觉后端；不可用时 sidecar 返回 501，调用方回退到默认框） */
  async detectMouth(video: string, atMs: number): Promise<{ box: [number, number, number, number]; source: string; score: number | null } | null> {
    try {
      const res = await this.request<{ box?: [number, number, number, number]; source?: string; score?: number | null }>(
        '/detect_mouth',
        { method: 'POST', body: JSON.stringify({ video, at_ms: atMs }), headers: { 'Content-Type': 'application/json' } },
        60_000
      )
      if (!res.box) return null
      return { box: res.box, source: res.source ?? 'unknown', score: res.score ?? null }
    } catch {
      return null
    }
  }

  async modelsStatus(): Promise<{ demucs: boolean; musetalk: boolean; detail: string }> {
    try {
      const res = await this.request<{ models?: Record<string, { available?: boolean }>; detail?: string }>('/models', undefined, 10_000)
      return {
        demucs: !!res.models?.demucs?.available,
        musetalk: !!res.models?.musetalk?.available,
        detail: res.detail ?? ''
      }
    } catch {
      return { demucs: false, musetalk: false, detail: 'sidecar 不可达' }
    }
  }

  async downloadModels(which: 'demucs' | 'musetalk' | 'all'): Promise<Record<string, unknown>> {
    return this.request('/models/download', {
      method: 'POST',
      body: JSON.stringify({ which }),
      headers: { 'Content-Type': 'application/json' }
    }, 20_000)
  }

  async modelsJobs(): Promise<Array<{ id: string; which: string; status: string; message: string; error: string | null; logs: string[] }>> {
    const res = await this.request<{ jobs: Array<{ id: string; which: string; status: string; message: string; error: string | null; logs: string[] }> }>('/models/jobs', undefined, 10_000)
    return res.jobs ?? []
  }
}

export const sidecar = new SidecarClient()
