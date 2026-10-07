/** SSE 订阅（SPEC-001 §7.5）：主进程 → 渲染层的唯一推送通道，断线自动重连 */
import type { ServerEvent } from '@shared/types'
import { API_BASE } from './client'

export type SseHandler = (event: ServerEvent) => void

export function connectSse(handler: SseHandler): () => void {
  let source: EventSource | null = null
  let delay = 1_000
  let disposed = false
  let timer: number | undefined

  const open = (): void => {
    if (disposed) return
    source = new EventSource(`${API_BASE}/api/events`)
    source.onmessage = (msg) => {
      delay = 1_000
      try {
        handler(JSON.parse(msg.data as string) as ServerEvent)
      } catch {
        /* 忽略非 JSON 帧（心跳注释不会进 onmessage） */
      }
    }
    source.onerror = () => {
      source?.close()
      source = null
      if (disposed) return
      timer = window.setTimeout(open, delay)
      delay = Math.min(delay * 2, 15_000)
    }
  }

  open()

  return () => {
    disposed = true
    if (timer) window.clearTimeout(timer)
    source?.close()
  }
}
