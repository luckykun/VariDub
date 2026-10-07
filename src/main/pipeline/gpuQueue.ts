/**
 * 本地 GPU 任务串行锁（SPEC-001 §7.7-4）：全局唯一消费者，同一时刻仅 1 个 GPU 任务。
 * sidecar 崩溃自动重启一次，仍失败则任务置 error 并提示。
 */
import { emit } from '../events'
import { log } from '../logger'

export type GpuTaskKind = 'separate' | 'lipsync'

interface QueueItem {
  kind: GpuTaskKind
  label: string
  projectId: string
  run: () => Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

const pending: QueueItem[] = []
let current: QueueItem | null = null

export function gpuBusy(): { busy: boolean; label: string | null; jobId: string | null; queueLength: number } {
  return {
    busy: current !== null,
    label: current ? current.label : null,
    jobId: current ? `${current.kind}:${current.projectId}` : null,
    queueLength: pending.length
  }
}

function announce(): void {
  emit({
    type: 'gpu:occupy',
    jobId: current ? `${current.kind}:${current.projectId}` : null,
    label: current ? current.label : null
  })
}

/** 入队执行；调用方拿到的是任务结果（串行保证 16GB 内存 + 6GB 显存不爆） */
export function enqueueGpu<O>(kind: GpuTaskKind, label: string, projectId: string, run: () => Promise<O>): Promise<O> {
  let item!: QueueItem
  const promise = new Promise<O>((resolveP, rejectP) => {
    item = {
      kind,
      label,
      projectId,
      run,
      resolve: resolveP as (v: unknown) => void,
      reject: rejectP
    }
  })
  pending.push(item)
  log.info('gpuQueue', `入队 ${kind}（${label}），队列长度 ${pending.length}`)
  drain()
  return promise
}

function drain(): void {
  if (current) return
  const next = pending.shift()
  if (!next) {
    announce()
    return
  }
  current = next
  announce()
  void (async () => {
    try {
      const value = await next.run()
      next.resolve(value)
    } catch (err) {
      next.reject(err)
    } finally {
      current = null
      log.info('gpuQueue', `完成 ${next.kind}（${next.label}）`)
      drain()
    }
  })()
}

export function clearQueue(): void {
  pending.length = 0
}
