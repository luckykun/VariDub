/**
 * 时段感知路由（Time-Aware Routing，SPEC-001 §5.4）——单点实现。
 * 所有 chat / vision 调用必须经此取模型名，禁止散落的 if 判断（§7.7-5）。
 * 判定发生在任务提交时刻，不追踪执行中跨时段切换。
 */
import { getBool, getSetting } from '../db/repos/settings'
import type { ModelRouteDto, ResolvedModel, RouteStage } from '../../shared/types'
import { DAY_LIGHT_MODEL, NIGHT_HEAVY_MODEL, ROUTE_STAGE_LABELS, TIME_AWARE_STAGES } from '../../shared/models'
import { isInWindow, msUntilWindow, parseWindow } from '../util/time'

export interface StageModelSetting {
  /** 设置表 key */
  key: string
  stage: RouteStage
}

export const STAGE_SETTING: Record<RouteStage, StageModelSetting> = {
  shot_analysis: { key: 'route.stage1.model', stage: 'shot_analysis' },
  translate: { key: 'route.stage3.model', stage: 'translate' }
}

export function discountWindow(): string {
  return getSetting('route.discount_window') || '22:00-08:00'
}

export function timeAwareEnabled(): boolean {
  return getBool('route.time_aware')
}

export function inDiscountWindow(at: Date = new Date()): boolean {
  return isInWindow(at, discountWindow())
}

/** 距下一次进入折扣窗口（分钟），用于「建议夜间重跑」提示 */
export function minutesUntilWindow(at: Date = new Date()): number | null {
  const ms = msUntilWindow(at, discountWindow())
  return ms === null ? null : Math.round(ms / 60_000)
}

/**
 * 取环节生效模型：
 * - 手动覆盖（下拉框选了具体模型）→ 恒用该模型
 * - auto → 时段路由开：夜间 qwen3.8-max（4 折）/ 白天 qwen3.8-flash；时段路由关 → qwen3.8-flash
 */
export function resolve(stage: RouteStage, at: Date = new Date()): ResolvedModel {
  const spec = STAGE_SETTING[stage]
  const override = (getSetting(spec.key) || 'auto').trim()
  const window = discountWindow()
  const night = isInWindow(at, window)
  const timeAware = timeAwareEnabled() && TIME_AWARE_STAGES.includes(stage)
  const parsed = parseWindow(window)

  let model: string
  let mode: ResolvedModel['mode']
  if (override !== 'auto') {
    model = override
    mode = 'manual'
  } else {
    model = timeAware && night ? NIGHT_HEAVY_MODEL : DAY_LIGHT_MODEL
    mode = 'auto'
  }

  const discountable = model === NIGHT_HEAVY_MODEL || model === DAY_LIGHT_MODEL
  const discountActive = discountable && night && mode === 'auto'
  const badge =
    mode === 'manual'
      ? `手动指定${night && discountable ? ' · 夜间4折可用' : ''}`
      : discountActive
        ? '夜间4折生效'
        : timeAware
          ? '标准计价'
          : '时段路由已关'

  return {
    stage,
    model,
    discountActive,
    badge,
    mode,
    window: { start: parsed.startLabel, end: parsed.endLabel, inWindow: night }
  }
}

/** 供 chat/vision 调用直接取模型名 */
export function modelFor(stage: RouteStage): string {
  return resolve(stage).model
}

export function routeDto(stage: RouteStage, candidates: string[]): ModelRouteDto {
  const spec = STAGE_SETTING[stage]
  const override = getSetting(spec.key) || 'auto'
  return {
    stage,
    label: ROUTE_STAGE_LABELS[stage],
    auto: override === 'auto',
    override: override === 'auto' ? null : override,
    candidates,
    effective: resolve(stage)
  }
}
