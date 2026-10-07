/** 底部导航条（§3 通用规则：上一步 / 下一步；未确认则下一步锁定） */
import { Check, ChevronLeft, TriangleAlert } from 'lucide-react'
import { STEP_LABELS, type StepId } from '@shared/types'
import type { GateIssue } from '@shared/api'
import type { StepView } from '@renderer/components/Stepper'

export function StepFooter({
  step,
  steps,
  issues,
  busy,
  running,
  onPrev,
  onNext
}: {
  step: StepId
  steps: StepView[]
  issues: GateIssue[]
  busy?: boolean
  running?: boolean
  onPrev: () => void
  onNext: () => void
}): JSX.Element {
  const view = steps.find((s) => s.step === step)
  const blocking = issues.filter((i) => i.level === 'block')
  const warns = issues.filter((i) => i.level === 'warn')
  const nextStep: StepId | null = step < 6 ? ((step + 1) as StepId) : null
  const confirmed = view?.state === 'confirmed'

  return (
    /* 定高（--bar-h）且靠上下居中：原来用 py-3，遇到阻塞/提醒多一行就变高，
       左侧菜单底栏的上描边与它的上描边就对不齐了（SPEC §7.6） */
    <footer className="flex h-[var(--bar-h)] shrink-0 items-center justify-between gap-4 border-t border-hairline bg-canvas px-6">
      <button type="button" className="btn btn-ghost" disabled={step === 1} onClick={onPrev}>
        <ChevronLeft size={14} />
        上一步
      </button>

      {/* 中间提示列：定高后溢出部分不往上下泄（提醒文本本身带了 title 全文） */}
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1 overflow-hidden">
        {blocking.length > 0 ? (
          <span className="flex items-center gap-2 text-[12px] text-error">
            <TriangleAlert size={13} />
            {blocking[0].message}
            {blocking.length > 1 ? ` （共 ${blocking.length} 项待处理）` : ''}
          </span>
        ) : (
          <span className="truncate text-[12px] text-body">{view?.hint ?? STEP_LABELS[step]}</span>
        )}
        {warns.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-warn" title={warns.map((w) => w.message).join('；')}>
            <TriangleAlert size={11} />
            {warns.length} 项提醒：{warns.map((w) => w.message).join('；')}
          </span>
        )}
      </div>

      <button
        type="button"
        className="btn btn-accent"
        disabled={busy || running || blocking.length > 0 || confirmed}
        title={confirmed ? '本步已确认' : blocking.length > 0 ? '还有阻塞项未处理' : '确认本步并解锁下一步'}
        onClick={onNext}
      >
        {confirmed ? <Check size={13} /> : null}
        {confirmed ? '本步已确认' : step === 6 ? '确认导出完成' : `确认，下一步：${nextStep ? STEP_LABELS[nextStep] : ''}`}
      </button>
    </footer>
  )
}
