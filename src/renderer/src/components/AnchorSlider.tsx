/**
 * 句级时间锚点拖拽（SPEC-001 §3.3：每句显示 `起 → 止 · 时长 · 超支量`，可拖动两端重设起止）。
 * 拖动过程中只改本地值，松手才提交（避免每帧一次 PATCH + 下游 stale 风暴）。
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp, msClock, msShort, signed } from '@renderer/util/format'

type DragKind = 'start' | 'body' | 'end'

export function AnchorSlider({
  startMs,
  endMs,
  totalMs,
  overflowMs = 0,
  stepMs = 10,
  minMs = 200,
  disabled = false,
  onCommit
}: {
  startMs: number
  endMs: number
  totalMs: number
  /** > 0 表示配音/译文超出锚点窗口，标红 */
  overflowMs?: number
  stepMs?: number
  minMs?: number
  disabled?: boolean
  onCommit: (startMs: number, endMs: number) => void
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const localRef = useRef({ startMs, endMs })
  const grabRef = useRef(0)
  const [local, setLocal] = useState({ startMs, endMs })
  const [drag, setDrag] = useState<DragKind | null>(null)

  useEffect(() => {
    localRef.current = local
  }, [local])

  // 外部值变化（SSE 刷新）且没在拖拽时，回到真值
  useEffect(() => {
    if (drag === null) setLocal({ startMs, endMs })
  }, [startMs, endMs, drag])

  const span = Math.max(1, totalMs)

  function msFromClientX(clientX: number): number {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    return Math.round((ratio * span) / stepMs) * stepMs
  }

  function begin(kind: DragKind, e: ReactPointerEvent<Element>): void {
    if (disabled) return
    e.preventDefault()
    grabRef.current = msFromClientX(e.clientX) - localRef.current.startMs
    setDrag(kind)
  }

  useEffect(() => {
    if (drag === null) return
    const onMove = (e: PointerEvent): void => {
      const at = msFromClientX(e.clientX)
      setLocal((cur) => {
        if (drag === 'start') return { startMs: clamp(at, 0, cur.endMs - minMs), endMs: cur.endMs }
        if (drag === 'end') return { startMs: cur.startMs, endMs: clamp(at, cur.startMs + minMs, span) }
        const width = cur.endMs - cur.startMs
        const next = clamp(at - grabRef.current, 0, span - width)
        return { startMs: Math.round(next / stepMs) * stepMs, endMs: Math.round((next + width) / stepMs) * stepMs }
      })
    }
    const onUp = (): void => {
      setDrag(null)
      const { startMs: s, endMs: en } = localRef.current
      if (s !== startMs || en !== endMs) onCommit(s, en)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, span, stepMs, minMs, startMs, endMs, onCommit])

  const left = (local.startMs / span) * 100
  const width = Math.max(0.6, ((local.endMs - local.startMs) / span) * 100)
  const overflowing = overflowMs > 0

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={trackRef}
        className={`relative h-[18px] w-full select-none border border-hairline bg-canvas ${disabled ? 'opacity-50' : 'cursor-ew-resize'}`}
        title="拖动两端锚点重设起止时间"
        onPointerDown={(e) => {
          if (disabled) return
          const at = msFromClientX(e.clientX)
          if (at < local.startMs || at > local.endMs) begin('body', e)
        }}
      >
        {/* 其他句的锚点，提供上下文 */}
        <div
          className={`absolute top-0 h-full ${overflowing ? 'bg-error/30' : 'bg-info/25'}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        <button
          type="button"
          aria-label="起始锚点"
          disabled={disabled}
          onPointerDown={(e) => begin('start', e)}
          className="absolute top-[-3px] size-[8px] -translate-x-1/2 rounded-full border border-ink bg-accent"
          style={{ left: `${left}%` }}
        />
        <button
          type="button"
          aria-label="结束锚点"
          disabled={disabled}
          onPointerDown={(e) => begin('end', e)}
          className="absolute top-[-3px] size-[8px] -translate-x-1/2 rounded-full border border-ink bg-accent"
          style={{ left: `${left + width}%` }}
        />
      </div>

      <div className="mono flex flex-wrap items-center gap-x-3 gap-y-[2px] text-[11px] text-muted">
        <span className="text-body">
          {msClock(local.startMs)} → {msClock(local.endMs)}
        </span>
        <span>时长 {msShort(local.endMs - local.startMs)}</span>
        <span className={overflowing ? 'text-error' : 'text-success'}>
          {overflowing ? `超支 ${signed(overflowMs)}` : `余量 ${signed(-overflowMs)}`}
        </span>
        {drag !== null && <span className="text-accent">拖拽中，松手生效</span>}
      </div>
    </div>
  )
}
