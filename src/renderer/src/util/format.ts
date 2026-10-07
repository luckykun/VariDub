/** 时间码/体积等格式化（时间码一律等宽字体展示，§7.6 mono token） */

export function msClock(ms: number, showMs = true): string {
  const safe = Math.max(0, Math.round(ms))
  const total = safe / 1000
  const m = Math.floor(total / 60)
  const s = Math.floor(total % 60)
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return showMs ? `${base}.${String(safe % 1000).padStart(3, '0')}` : base
}

export function msShort(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const v = Math.max(0, Math.round(ms))
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 1 : 2)}s` : `${v}ms`
}

export function signed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const v = Math.round(ms)
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)}ms`
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(i <= 1 ? 0 : 1)} ${units[i]}`
}

export function fileName(path: string | null | undefined): string {
  if (!path) return '—'
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function nowLabel(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}
