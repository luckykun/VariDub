/** 通用小组件（token 全部来自 styles/theme.css，禁止硬编码颜色） */
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

export type Tone = 'accent' | 'success' | 'warn' | 'error' | 'info' | 'muted'

export const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-accent',
  success: 'text-success',
  warn: 'text-warn',
  error: 'text-error',
  info: 'text-info',
  muted: 'text-muted'
}

const TONE_BG: Record<Tone, string> = {
  accent: 'bg-accent/15 border-accent/40',
  success: 'bg-success/15 border-success/40',
  warn: 'bg-warn/15 border-warn/40',
  error: 'bg-error/15 border-error/40',
  info: 'bg-info/15 border-info/40',
  // 徽章是正常内容不是高亮态：黑底 + 灰描边，实灰留给选中/悬浮
  muted: 'bg-canvas border-hairline'
}

export function Badge({ tone = 'muted', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }): JSX.Element {
  return <span className={`inline-flex items-center gap-1 border px-2 py-[2px] text-[11px] ${TONE_BG[tone]} ${TONE_TEXT[tone]} ${className}`}>{children}</span>
}

export function Panel({
  title,
  aside,
  children,
  className = '',
  bodyClass = 'p-4',
  bodyScroll = true
}: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  /** 设 false 时卡内不产生滚动条（设置页用，避免页面里出现第二条滚动条） */
  bodyScroll?: boolean
}): JSX.Element {
  return (
    <section className={`card flex min-h-0 flex-col ${className}`}>
      {(title || aside) && (
        /* Header 定高 + 内容垂直居中：标题有 12/13px 两档，右侧又可能放徽章或行内小按钮，
           跟着内容走会让并排卡片的上描边错开（SPEC §7.6 线条对齐） */
        <header className="flex h-[var(--panel-header-h)] shrink-0 items-center justify-between gap-4 overflow-hidden border-b border-hairline px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-ink">{title}</div>
          <div className="flex shrink-0 items-center gap-2">{aside}</div>
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyScroll ? 'overflow-auto' : ''} ${bodyClass}`}>{children}</div>
    </section>
  )
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex flex-col gap-[2px]">
      <span className="inline-flex items-center gap-2">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label && <span className="text-body">{label}</span>}
      </span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </span>
  )
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 text-body">
      <Loader2 size={14} className="animate-spin" />
      {label ?? '处理中'}
    </span>
  )
}

export function EmptyState({ icon, text, action }: { icon?: ReactNode; text: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-muted">
      {icon}
      <div className="max-w-[420px] text-[12px]">{text}</div>
      {action}
    </div>
  )
}

export function Meter({ value, tone = 'accent' }: { value: number; tone?: Tone }): JSX.Element {
  const bar: Record<Tone, string> = {
    accent: 'bg-accent',
    success: 'bg-success',
    warn: 'bg-warn',
    error: 'bg-error',
    info: 'bg-info',
    muted: 'bg-muted'
  }
  // 凹槽用半透灰（靠黑底变暗），实心灰只属于高亮态
  return (
    <div className="h-[3px] w-full bg-elevated/60">
      <div className={`h-full ${bar[tone]}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

export function KeyVal({ k, v, mono = false }: { k: string; v: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-[11px] text-muted">{k}</span>
      <span className={mono ? 'mono text-[12px] text-ink' : 'text-[12px] text-body'}>{v}</span>
    </div>
  )
}
