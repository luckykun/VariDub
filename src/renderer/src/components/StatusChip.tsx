/** 状态徽章（SPEC-001 §7.6：绿=完成 / 红=当前与危险 / 黄=待办警示 / 灰=锁定） */
import { Check, Clock, Circle, Lock, Pause, RotateCcw, TriangleAlert, X } from 'lucide-react'
import type { JobState, StepState } from '@shared/types'
import type { ShotDto } from '@shared/types'
import { Badge, type Tone } from '@renderer/components/ui'

const STEP_TONE: Record<StepState, Tone> = {
  locked: 'muted',
  ready: 'info',
  running: 'accent',
  review: 'warn',
  confirmed: 'success',
  error: 'error'
}

const STEP_LABEL: Record<StepState, string> = {
  locked: '锁定',
  ready: '待运行',
  running: '运行中',
  review: '待确认',
  confirmed: '已确认',
  error: '失败'
}

function StepIcon({ state }: { state: StepState }): JSX.Element {
  const map = {
    locked: <Lock size={11} />,
    ready: <Circle size={11} />,
    running: <Clock size={11} />,
    review: <TriangleAlert size={11} />,
    confirmed: <Check size={11} />,
    error: <X size={11} />
  } as const
  return map[state]
}

export function StepStatusChip({ state }: { state: StepState }): JSX.Element {
  return (
    <Badge tone={STEP_TONE[state]}>
      <StepIcon state={state} />
      {STEP_LABEL[state]}
    </Badge>
  )
}

const JOB_TONE: Record<JobState, Tone> = {
  queued: 'muted',
  running: 'accent',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'warn'
}

const JOB_LABEL: Record<JobState, string> = {
  queued: '排队',
  running: '进行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消'
}

export function JobStatusChip({ state }: { state: JobState }): JSX.Element {
  return (
    <Badge tone={JOB_TONE[state]}>
      {state === 'running' ? <Pause size={11} /> : null}
      {JOB_LABEL[state]}
    </Badge>
  )
}

const ACCEPT_TONE: Record<ShotDto['acceptStatus'], Tone> = {
  pending: 'muted',
  accepted: 'success',
  rejected: 'error',
  rendering: 'accent',
  queued: 'muted',
  failed: 'error'
}

const ACCEPT_LABEL: Record<ShotDto['acceptStatus'], string> = {
  pending: '待处理',
  accepted: '已接受',
  rejected: '已拒绝',
  rendering: '渲染中',
  queued: '排队',
  failed: '失败'
}

export function ShotAcceptChip({ status }: { status: ShotDto['acceptStatus'] }): JSX.Element {
  return (
    <Badge tone={ACCEPT_TONE[status]}>
      {status === 'accepted' ? <Check size={11} /> : status === 'failed' ? <X size={11} /> : status === 'pending' ? <RotateCcw size={11} /> : null}
      {ACCEPT_LABEL[status]}
    </Badge>
  )
}

export function QualityChip({ level, note }: { level: 'ok' | 'short' | 'noisy'; note?: string | null }): JSX.Element {
  const tone: Tone = level === 'ok' ? 'success' : level === 'short' ? 'warn' : 'error'
  const text = level === 'ok' ? '样本充足' : level === 'short' ? '样本偏短' : '信噪比差'
  return (
    <Badge tone={tone}>
      {level === 'ok' ? <Check size={11} /> : <TriangleAlert size={11} />}
      {text}
      {note ? ` · ${note}` : ''}
    </Badge>
  )
}
