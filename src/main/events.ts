/** 主进程 → 渲染层单向事件总线（SSE /api/events 的实现基础，SPEC-001 §7.5） */
import type { ServerEvent } from '../shared/types'

type Listener = (evt: ServerEvent) => void

const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emit(evt: ServerEvent): void {
  for (const listener of listeners) {
    try {
      listener(evt)
    } catch {
      listeners.delete(listener)
    }
  }
}

export function listenerCount(): number {
  return listeners.size
}
