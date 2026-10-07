/** 大号步骤条（§4 屏 02A-02F：绿勾=已确认，红实心=当前，灰圈=未解锁，锁标=门禁） */
import { Check, ChevronRight, Lock } from 'lucide-react'
import { STEP_IDS, STEP_LABELS, type StepId, type StepState } from '@shared/types'

export interface StepView {
  step: StepId
  state: StepState
  locked: boolean
  hint: string
}

function nodeTone(state: StepState, active: boolean, locked: boolean): { ring: string; text: string; fill: string } {
  if (locked) return { ring: 'border-hairline', text: 'text-muted', fill: 'bg-canvas' }
  if (state === 'confirmed') return { ring: 'border-success', text: 'text-success', fill: 'bg-success/10' }
  if (state === 'error') return { ring: 'border-error', text: 'text-error', fill: 'bg-error/10' }
  if (state === 'running') return { ring: 'border-accent', text: 'text-accent', fill: 'bg-accent/10' }
  if (state === 'review') return { ring: 'border-warn', text: 'text-warn', fill: 'bg-warn/10' }
  if (active) return { ring: 'border-accent', text: 'text-accent', fill: 'bg-accent/10' }
  return { ring: 'border-muted', text: 'text-body', fill: 'bg-canvas' }
}

export function Stepper({ steps, active, onPick }: { steps: StepView[]; active: StepId; onPick: (step: StepId) => void }): JSX.Element {
  return (
    <nav className="flex items-stretch gap-1 border-y border-hairline bg-canvas px-4 py-3">
      {STEP_IDS.map((id, i) => {
        const view = steps.find((s) => s.step === id)
        const state = view?.state ?? 'locked'
        const locked = view?.locked ?? true
        const tone = nodeTone(state, active === id, locked)
        const isActive = active === id
        return (
          <div key={id} className="flex flex-1 items-center gap-1">
            <button
              type="button"
              disabled={locked}
              onClick={() => onPick(id)}
              title={locked ? `门禁：${view?.hint ?? '上一步未确认'}` : view?.hint}
              className={`group flex w-full items-center gap-3 border ${isActive ? 'border-accent' : 'border-transparent'} px-3 py-2 text-left transition-colors ${
                locked ? 'cursor-not-allowed opacity-60' : 'hover:border-hairline'
              }`}
            >
              <span className={`flex size-[26px] shrink-0 items-center justify-center rounded-full border ${tone.ring} ${tone.fill}`}>
                {state === 'confirmed' ? (
                  <Check size={14} className="text-success" />
                ) : locked ? (
                  <Lock size={12} className="text-muted" />
                ) : state === 'error' ? (
                  <span className="size-[10px] rounded-full bg-error" />
                ) : state === 'running' ? (
                  <span className="size-[10px] animate-pulse rounded-full bg-accent" />
                ) : isActive ? (
                  <span className="size-[10px] rounded-full bg-accent" />
                ) : (
                  <span className={`mono text-[11px] ${tone.text}`}>{i + 1}</span>
                )}
              </span>
              <span className="min-w-0">
                <span className={`mono block text-[10px] ${tone.text}`}>{String(i + 1).padStart(2, '0')}</span>
                <span className={`block truncate text-[13px] ${isActive ? 'text-ink' : tone.text}`}>{STEP_LABELS[id]}</span>
              </span>
            </button>
            {i < STEP_IDS.length - 1 && <ChevronRight size={14} className="shrink-0 text-hairline" />}
          </div>
        )
      })}
    </nav>
  )
}
