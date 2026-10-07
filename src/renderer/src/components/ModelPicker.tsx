/**
 * 步骤内模型选择器（SPEC-001 §5.4：下拉始终可选清单内任意模型，auto = 时段路由）。
 * 生效模型与「夜间 4 折」角标来自 /api/settings 的路由表，前端不自己算时间。
 */
import { Clock } from 'lucide-react'
import type { RouteStage } from '@shared/types'
import { Badge } from '@renderer/components/ui'
import { useAppStore } from '@renderer/stores/appStore'

export type PickerStage = 'stage1' | 'stage2' | 'stage3' | 'stage4' | 'stage5_keyframe' | 'stage5_motion'

/** 只有①③参与时段路由（§5.1），其余环节没有路由表行 */
const ROUTE_OF: Record<PickerStage, RouteStage | null> = {
  stage1: 'shot_analysis',
  stage2: null,
  stage3: 'translate',
  stage4: null,
  stage5_keyframe: null,
  stage5_motion: null
}

export function ModelPicker({
  stage,
  value,
  onChange,
  label = '本步骤模型',
  disabled = false
}: {
  stage: PickerStage
  value: string
  onChange: (model: string) => void
  label?: string
  disabled?: boolean
}): JSX.Element {
  const catalog = useAppStore((s) => s.catalog)
  const routes = useAppStore((s) => s.routes)

  const options = catalog?.stageOptions[stage] ?? []
  const stageRoute = ROUTE_OF[stage]
  const route = stageRoute ? routes.find((r) => r.stage === stageRoute) ?? null : null

  const labelOf = (id: string): string => (id === 'auto' ? 'auto（时段路由自动）' : catalog?.models.find((m) => m.id === id)?.label ?? id)
  const noteOf = (id: string): string => catalog?.models.find((m) => m.id === id)?.note ?? ''

  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-input bg-canvas px-2 py-1 text-[12px] text-ink disabled:opacity-50"
      >
        {options.length === 0 && <option value={value || 'auto'}>{value || '使用设置页默认'}</option>}
        {options.map((id) => (
          <option key={id} value={id} title={noteOf(id)}>
            {labelOf(id)}
          </option>
        ))}
      </select>

      {route && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
          <span>当前生效</span>
          <span className="mono text-ink">{route.effective.model}</span>
          <Badge tone={route.effective.discountActive ? 'success' : 'muted'}>
            {route.effective.discountActive && <Clock size={10} />}
            {route.effective.badge}
          </Badge>
        </div>
      )}

      {catalog?.mockMode && <span className="text-[11px] text-warn">Mock 模式：调用不发真实请求，产物为占位</span>}
    </div>
  )
}

/** 设置页/步骤页共用的「生效模型」纯展示行 */
export function RouteHint({ stage }: { stage: RouteStage }): JSX.Element | null {
  const route = useAppStore((s) => s.routes).find((r) => r.stage === stage)
  if (!route) return null
  return (
    <span className="mono text-[11px] text-muted">
      {route.effective.model}
      {route.effective.discountActive ? ' · 夜间4折' : ''}
    </span>
  )
}
