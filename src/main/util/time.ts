/** 时间码与折扣窗口工具（时间码统一 mono 字体展示，SPEC-001 §7.6） */

export interface WindowRange {
  startMin: number
  endMin: number
  startLabel: string
  endLabel: string
}

export function parseHm(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return 0
  const h = Math.min(23, Math.max(0, Number(m[1])))
  const mm = Math.min(59, Math.max(0, Number(m[2])))
  return h * 60 + mm
}

/** "22:00-08:00" → { startMin: 1320, endMin: 480 } */
export function parseWindow(spec: string): WindowRange {
  const parts = spec.split('-')
  const startLabel = (parts[0] ?? '22:00').trim()
  const endLabel = (parts[1] ?? '08:00').trim()
  return {
    startMin: parseHm(startLabel),
    endMin: parseHm(endLabel),
    startLabel,
    endLabel
  }
}

/** 夜间窗口 [22:00, 08:00) 判定，支持跨零点 */
export function isInWindow(at: Date, spec: string): boolean {
  const w = parseWindow(spec)
  const cur = at.getHours() * 60 + at.getMinutes()
  if (w.startMin === w.endMin) return false
  if (w.startMin < w.endMin) return cur >= w.startMin && cur < w.endMin
  return cur >= w.startMin || cur < w.endMin
}

/** 距下一次进入窗口的毫秒数（夜间待办提示用） */
export function msUntilWindow(at: Date, spec: string): number | null {
  const w = parseWindow(spec)
  const cur = at.getHours() * 60 + at.getMinutes()
  let delta: number
  if (w.startMin < w.endMin) {
    if (cur >= w.startMin && cur < w.endMin) return 0
    delta = cur < w.startMin ? w.startMin - cur : 24 * 60 - cur + w.startMin
  } else {
    if (cur >= w.startMin || cur < w.endMin) return 0
    delta = w.startMin - cur
  }
  return delta * 60_000
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 时间码 HH:MM:SS.mmm（分镜表/锚点显示） */
export function formatTimecode(ms: number): string {
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(Math.round(ms))
  const h = Math.floor(abs / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  const s = Math.floor((abs % 60_000) / 1000)
  const milli = abs % 1000
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(Math.round(ms))
  const s = Math.floor(abs / 1000)
  const milli = abs % 1000
  return milli === 0 ? `${(s / 1).toFixed(0)}s` : `${(abs / 1000).toFixed(2)}s`
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}
