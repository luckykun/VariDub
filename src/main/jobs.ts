/**
 * 任务注册表：REST 启动任务返回 taskId，进度经 SSE 推送（SPEC-001 §7.5）。
 * 同一项目同一步骤同时只允许 1 个任务，避免重复计费与产物竞争。
 */
import type { JobDto, JobState, StepId } from '../shared/types'
import { emit } from './events'
import { newId } from './util/id'

export class CancelledError extends Error {
  constructor(task = '') {
    super(`任务已取消${task ? `：${task}` : ''}`)
    this.name = 'CancelledError'
  }
}

export interface JobRecord {
  dto: JobDto
  cancelled: boolean
  /** 任务体抛出的 promise，供「等待当前任务完成」的编排逻辑使用 */
  promise: Promise<void>
}

const jobs = new Map<string, JobRecord>()
const MAX_HISTORY = 200

export function createJob(projectId: string, step: StepId, name: string): JobRecord {
  const id = newId('job')
  const record: JobRecord = {
    cancelled: false,
    promise: Promise.resolve(),
    dto: {
      id,
      projectId,
      step,
      name,
      state: 'queued' as JobState,
      progress: 0,
      message: null,
      error: null,
      logPath: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    }
  }
  jobs.set(id, record)
  trimHistory()
  publish(record)
  return record
}

export function getJob(id: string): JobRecord | null {
  return jobs.get(id) ?? null
}

export function listJobs(projectId?: string): JobDto[] {
  return [...jobs.values()]
    .filter((j) => !projectId || j.dto.projectId === projectId)
    .sort((a, b) => (a.dto.startedAt < b.dto.startedAt ? 1 : -1))
    .slice(0, 60)
    .map((j) => j.dto)
}

export function runningJobFor(projectId: string, step: StepId): JobDto | null {
  for (const j of jobs.values()) {
    if (j.dto.projectId === projectId && j.dto.step === step && (j.dto.state === 'running' || j.dto.state === 'queued')) return j.dto
  }
  return null
}

export function markRunning(job: JobRecord): void {
  job.dto.state = 'running'
  publish(job)
}

export function setProgress(job: JobRecord, progress: number, message?: string | null): void {
  job.dto.progress = Math.max(0, Math.min(1, progress))
  if (message !== undefined) job.dto.message = message
  publish(job)
}

export function setLogPath(job: JobRecord, path: string | null): void {
  job.dto.logPath = path
  publish(job)
}

export function finish(job: JobRecord, state: JobState, error?: string | null): void {
  job.dto.state = state
  job.dto.finishedAt = new Date().toISOString()
  if (state === 'succeeded') job.dto.progress = 1
  if (error !== undefined) job.dto.error = error
  publish(job)
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  if (job.dto.state === 'succeeded' || job.dto.state === 'failed' || job.dto.state === 'cancelled') return false
  job.cancelled = true
  setProgress(job, job.dto.progress, '取消中…（当前子任务完成后停止）')
  return true
}

export function throwIfCancelled(job: JobRecord): void {
  if (job.cancelled) throw new CancelledError(job.dto.name)
}

function publish(job: JobRecord): void {
  emit({ type: 'job:update', job: { ...job.dto } })
}

function trimHistory(): void {
  if (jobs.size <= MAX_HISTORY) return
  const finished = [...jobs.values()]
    .filter((j) => j.dto.state === 'succeeded' || j.dto.state === 'failed' || j.dto.state === 'cancelled')
    .sort((a, b) => (a.dto.finishedAt! < b.dto.finishedAt! ? -1 : 1))
  for (const j of finished) {
    if (jobs.size <= MAX_HISTORY) break
    jobs.delete(j.dto.id)
  }
}
