/**
 * DashScope 异步任务客户端（步骤⑤ wan 关键帧 / happyhorse 图生视频，SPEC-001 §7.7-1、§7.7-6）。
 * - 提交后轮询：间隔 5s 起指数退避，上限 60s
 * - 单任务 >15min 判失败
 * - 并发信号量 ≤2（防限流），可由 render.concurrency 调整
 * - taskId 持久化到 Artifact 表：重启后先查未完成 task，避免重复计费
 */
import { getApiKey } from '../safeStorage'
import { getNum, getSetting, isMock } from '../db/repos/settings'
import { log } from '../logger'
import { BailianError, mockMode } from './chat'
import { downloadFile } from '../util/download'
import { emit } from '../events'

export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'

export interface AsyncTaskSpec {
  model: string
  input: Record<string, unknown>
  parameters?: Record<string, unknown>
}

export interface TaskOutcome {
  taskId: string
  status: TaskStatus
  /** 结果文件可下载地址 */
  url: string | null
  raw: Record<string, unknown>
  message: string | null
}

const POLL_START_MS = 5_000
const POLL_MAX_MS = 60_000
const TASK_TIMEOUT_MS = 15 * 60_000

class Semaphore {
  private active = 0
  private waiting: Array<() => void> = []
  constructor(private limit: number) {}

  setLimit(n: number): void {
    this.limit = Math.max(1, n)
    this.drain()
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolveP) => this.waiting.push(resolveP))
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  get occupied(): number {
    return this.active
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      const next = this.waiting.shift()
      if (!next) break
      this.active += 1
      next()
    }
  }
}

/**
 * 云端并发闸（§7.7-3：同时不超过 2 个云端重任务）。
 * 必须惰性创建：本模块在 initDb() 之前就被 import，构造期读设置会抛「数据库未初始化」；
 * 另外 limit 每次取用前重读，设置页改了立即生效（§3.6）。
 */
const CLOUD_LIMIT_MAX = 2
let cloudSemaphore: Semaphore | null = null

function cloudLimit(): number {
  return Math.min(CLOUD_LIMIT_MAX, Math.max(1, getNum('render.concurrency') || CLOUD_LIMIT_MAX))
}

function cloudGate(): Semaphore {
  if (!cloudSemaphore) cloudSemaphore = new Semaphore(cloudLimit())
  cloudSemaphore.setLimit(cloudLimit())
  return cloudSemaphore
}

export function cloudQueueState(): { active: number; limit: number } {
  return { active: cloudSemaphore?.occupied ?? 0, limit: cloudLimit() }
}

function headers(): Record<string, string> {
  const key = getApiKey()
  if (!key && !mockMode()) throw new BailianError('未配置 API-KEY：请到「设置」填入百炼 TokenPlan 团队版 KEY')
  return { Authorization: `Bearer ${key ?? 'MOCK'}`, 'Content-Type': 'application/json' }
}

function base(): string {
  return (getSetting('api.base_url') || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, '')
}

/** 模型 → 提交端点（不同能力线走不同 path） */
export function endpointFor(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('image')) return '/services/aigc/image2image/image-synthesis'
  if (m.includes('i2v') || m.includes('r2v') || m.includes('video')) return '/services/aigc/video-generation/video-synthesis'
  return '/services/aigc/general-generation/generation'
}

export async function submitTask(spec: AsyncTaskSpec): Promise<string> {
  if (mockMode()) return `mock-task-${Math.random().toString(36).slice(2, 10)}`
  const res = await fetch(`${base()}${endpointFor(spec.model)}`, {
    method: 'POST',
    headers: { ...headers(), 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model: spec.model, input: spec.input, parameters: spec.parameters ?? {} }),
    signal: AbortSignal.timeout(60_000)
  })
  const text = await res.text()
  if (!res.ok) throw new BailianError(`任务提交失败 HTTP ${res.status}：${text.slice(0, 300)}`, { status: res.status, retriable: res.status !== 400 })
  const json = JSON.parse(text) as Record<string, unknown>
  const output = (json.output ?? {}) as Record<string, unknown>
  const taskId = String(output.task_id ?? json.taskId ?? '')
  if (!taskId) throw new BailianError(`提交响应缺少 task_id：${text.slice(0, 200)}`)
  return taskId
}

export async function queryTask(taskId: string): Promise<TaskOutcome> {
  if (mockMode()) return { taskId, status: 'SUCCEEDED', url: null, raw: { mock: true }, message: null }
  const res = await fetch(`${base()}/tasks/${encodeURIComponent(taskId)}`, { headers: headers(), signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  if (!res.ok) throw new BailianError(`任务查询失败 HTTP ${res.status}：${text.slice(0, 240)}`, { status: res.status, retriable: true })
  const json = JSON.parse(text) as Record<string, unknown>
  const output = (json.output ?? {}) as Record<string, unknown>
  const status = String(output.task_status ?? 'UNKNOWN') as TaskStatus
  const message = output.message ? String(output.message) : ((json.message as string) ?? null)
  const results = Array.isArray(output.results) ? (output.results as Record<string, unknown>[]) : []
  const url =
    (output.video_url as string) ??
    (output.url as string) ??
    (results[0]?.url as string) ??
    (results[0]?.video_url as string) ??
    (results.find((r) => typeof r.url === 'string')?.url as string) ??
    null
  return { taskId, status: status === 'SUCCEEDED' || status === 'FAILED' || status === 'PENDING' || status === 'RUNNING' ? status : 'UNKNOWN', url, raw: json, message }
}

/** 轮询直到终态；5s 起指数退避、上限 60s、总时长 >15min 判失败 */
export async function pollUntilDone(
  taskId: string,
  onTick?: (outcome: TaskOutcome, elapsedMs: number) => void
): Promise<TaskOutcome> {
  if (mockMode()) {
    await new Promise((r) => setTimeout(r, 300))
    return { taskId, status: 'SUCCEEDED', url: null, raw: { mock: true }, message: null }
  }
  const started = Date.now()
  let interval = POLL_START_MS
  for (;;) {
    const outcome = await queryTask(taskId)
    onTick?.(outcome, Date.now() - started)
    if (outcome.status === 'SUCCEEDED' || outcome.status === 'FAILED') return outcome
    if (Date.now() - started > TASK_TIMEOUT_MS) {
      return { ...outcome, status: 'FAILED', message: `任务超时（>${Math.round(TASK_TIMEOUT_MS / 60_000)} 分钟），可重跑` }
    }
    await new Promise((r) => setTimeout(r, interval))
    interval = Math.min(POLL_MAX_MS, Math.round(interval * 1.6))
  }
}

export interface RunTaskOptions {
  spec: AsyncTaskSpec
  /** 提交成功即刻回调（用于把 taskId 落库到 Artifact，实现断点续跑） */
  onSubmitted?: (taskId: string) => Promise<void> | void
  onTick?: (outcome: TaskOutcome, elapsedMs: number) => void
  /** 已有 taskId（续跑）时跳过提交，直接轮询 */
  existingTaskId?: string | null
  destPath?: string | null
  label?: string
}

/** 提交 + 轮询 + 下载，全程受信号量约束（并发 ≤2） */
export async function runTask(opts: RunTaskOptions): Promise<{ outcome: TaskOutcome; file: string | null }> {
  const gate = cloudGate()
  await gate.acquire()
  emit({ type: 'log', projectId: '', line: `云端任务排队：${opts.label ?? opts.spec.model}（占用 ${cloudQueueState().active}/${cloudQueueState().limit}）` })
  try {
    let taskId = opts.existingTaskId ?? null
    if (!taskId) {
      taskId = await submitTask(opts.spec)
      await opts.onSubmitted?.(taskId)
      log.info('asyncTask', `已提交 ${opts.spec.model} → ${taskId}`)
    } else {
      log.info('asyncTask', `续跑已有任务 ${taskId}（${opts.spec.model}）`)
    }
    const outcome = await pollUntilDone(taskId, opts.onTick)
    if (outcome.status !== 'SUCCEEDED') {
      throw new BailianError(`任务失败（${opts.spec.model}）：${outcome.message ?? outcome.status}`)
    }
    let file: string | null = null
    if (opts.destPath) {
      if (mockMode()) {
        file = null
      } else {
        if (!outcome.url) throw new BailianError(`任务成功但没有结果地址：${JSON.stringify(outcome.raw).slice(0, 240)}`)
        file = opts.destPath
        await downloadFile(outcome.url, file)
      }
    }
    return { outcome, file }
  } finally {
    gate.release()
  }
}

/** 重启续跑：把已提交但未完成的 task 查一遍终态并下载结果 */
export async function resumeTask(taskId: string, destPath: string): Promise<string | null> {
  if (isMock()) return null
  const outcome = await queryTask(taskId)
  if (outcome.status === 'SUCCEEDED' && outcome.url) {
    await downloadFile(outcome.url, destPath)
    return destPath
  }
  if (outcome.status === 'FAILED') return null
  const done = await pollUntilDone(taskId)
  if (done.status === 'SUCCEEDED' && done.url) {
    await downloadFile(done.url, destPath)
    return destPath
  }
  return null
}
