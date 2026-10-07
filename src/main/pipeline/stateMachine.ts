/**
 * 六步状态机 + 门禁（SPEC-001 §3 通用规则、§1.1-P1）。
 * locked → ready →（跑完）review → confirmed；上一步未确认则本步锁定。
 * 重跑上游会把下游降级为 review（改上游比改下游便宜，P3）。
 */
import type { ProjectDto, StepId, StepState } from '../../shared/types'
import type { GateIssue } from '../../shared/api'
import { STEP_IDS } from '../../shared/types'
import { emit } from '../events'
import { Lines, Projects, Shots, Speakers } from '../db/repos'

export type { GateIssue }

export function statesOf(project: ProjectDto): Record<StepId, StepState> {
  return project.stepStates
}

/** 本步是否可进入：第 1 步恒可，其余要求上一步 confirmed */
export function gateCheck(project: ProjectDto, step: StepId): { allowed: boolean; reason: string | null } {
  if (step === 1) return { allowed: true, reason: null }
  const prev = (step - 1) as StepId
  const prevState = project.stepStates[prev]
  if (prevState === 'confirmed') return { allowed: true, reason: null }
  return {
    allowed: false,
    reason: `上一步「${labelOf(prev)}」尚未确认（当前 ${prevState}）`
  }
}

function labelOf(step: StepId): string {
  const map: Record<StepId, string> = { 1: '视频解析', 2: '人声分离·识别', 3: '中→英翻译', 4: '音色克隆配音', 5: '3D 画面重绘', 6: '口型对齐·导出' }
  return map[step]
}

/** 确认门禁的内容校验：block 项存在时不允许确认 */
export function validateStep(project: ProjectDto, step: StepId): GateIssue[] {
  const issues: GateIssue[] = []
  const shots = Shots.list(project.id)
  const lines = Lines.list(project.id)
  const speakers = Speakers.list(project.id)

  if (step === 1) {
    if (shots.length === 0) issues.push({ level: 'block', message: '还没有分镜表，请先运行步骤①' })
    const bad = shots.filter((s) => s.endMs - s.startMs < 200)
    if (bad.length > 0) issues.push({ level: 'block', message: `${bad.length} 个分镜时长不足 0.2s，请拖动切点修正` })
    const noDesc = shots.filter((s) => !s.sceneDesc.trim()).length
    if (noDesc > 0) issues.push({ level: 'warn', message: `${noDesc} 个分镜没有场景描述（不影响后续，但建议补全）` })
  }

  if (step === 2) {
    if (lines.length === 0) issues.push({ level: 'block', message: '没有转写句子，请先运行步骤②（ASR）' })
    if (speakers.length === 0) issues.push({ level: 'block', message: '没有登记说话人，请确认 diarization 结果' })
    const empty = lines.filter((l) => !l.zhText.trim()).length
    if (empty > 0) issues.push({ level: 'warn', message: `${empty} 句中文文本为空，请校对` })
    const weak = speakers.filter((s) => s.sampleQuality !== 'ok')
    if (weak.length > 0) issues.push({ level: 'warn', message: `${weak.length} 位说话人音色样本偏弱（<15s 或信噪比差），建议手动补选区间` })
  }

  if (step === 3) {
    const unconfirmed = lines.filter((l) => l.confirmStatus !== 'confirmed')
    if (unconfirmed.length > 0) issues.push({ level: 'block', message: `还有 ${unconfirmed.length} / ${lines.length} 句未确认（改这里比改后面便宜）` })
    const noEn = lines.filter((l) => l.confirmStatus === 'confirmed' && !l.enText.trim())
    if (noEn.length > 0) issues.push({ level: 'block', message: `${noEn.length} 句已确认但英文为空` })
    const overflow = lines.filter((l) => l.overflowMs > 0 && l.overflowPolicy === 'none')
    if (overflow.length > 0) issues.push({ level: 'warn', message: `${overflow.length} 句译文超支且策略为「不处理」，配音可能被截断` })
  }

  if (step === 4) {
    const missing = lines.filter((l) => !l.dubWavPath)
    if (missing.length > 0) issues.push({ level: 'block', message: `${missing.length} 句还没有配音，请批量重生成` })
    const red = lines.filter((l) => l.similarity !== null && l.similarity < 80)
    if (red.length > 0) issues.push({ level: 'block', message: `${red.length} 句相似度 <80%（红标），请重配或在底部手动放行` })
    const stale = lines.filter((l) => l.anchorStale)
    if (stale.length > 0) issues.push({ level: 'warn', message: `${stale.length} 句的时间锚点在上游被改过，配音产物已过期` })
  }

  if (step === 5) {
    const pending = shots.filter((s) => s.acceptStatus !== 'accepted')
    if (pending.length > 0) issues.push({ level: 'block', message: `还有 ${pending.length} 个分镜未接受（绿）：${pending.length} / ${shots.length}` })
    const low = shots.filter((s) => s.consistencyScore !== null && s.consistencyScore < 0.75)
    if (low.length > 0) issues.push({ level: 'warn', message: `${low.length} 个分镜人脸一致性偏低，可「重跑低一致性分镜」` })
  }

  if (step === 6) {
    const noLip = lines.filter((l) => l.lipsyncStatus === 'failed')
    if (noLip.length > 0) issues.push({ level: 'warn', message: `${noLip.length} 句口型失败，可在问题句中跳回上游修改` })
  }

  return issues
}

export function blockReasons(issues: GateIssue[]): string[] {
  return issues.filter((i) => i.level === 'block').map((i) => i.message)
}

export function setStepState(projectId: string, step: StepId, state: StepState): void {
  const project = Projects.get(projectId)
  if (!project) return
  const next = { ...project.stepStates, [step]: state }
  const currentStep = step
  Projects.setSteps(projectId, next, currentStep)
  emit({ type: 'step:update', projectId, stepStates: next, currentStep })
}

/** 确认本步并解锁下一步 */
export function confirmStep(projectId: string, step: StepId, force = false): { ok: boolean; issues: GateIssue[] } {
  const project = Projects.get(projectId)
  if (!project) return { ok: false, issues: [{ level: 'block', message: '项目不存在' }] }
  const issues = validateStep(project, step)
  const blocked = blockReasons(issues)
  if (blocked.length > 0 && !force) return { ok: false, issues }

  const next = { ...project.stepStates, [step]: 'confirmed' as StepState }
  const following = (step + 1) as StepId
  if (STEP_IDS.includes(following) && next[following] === 'locked') next[following] = 'ready'
  const currentStep = STEP_IDS.includes(following) ? following : step
  Projects.setSteps(projectId, next, step === 6 ? 6 : currentStep)
  if (step === 6) Projects.patch(projectId, { status: 'done' })
  emit({ type: 'step:update', projectId, stepStates: next, currentStep })
  emit({ type: 'project:update', projectId })
  return { ok: true, issues }
}

/** 打开已确认的步骤（回改上游）：本步回到 review，下游需重新确认 */
export function reopenStep(projectId: string, step: StepId): void {
  const project = Projects.get(projectId)
  if (!project) return
  const next = { ...project.stepStates }
  next[step] = next[step] === 'confirmed' ? 'review' : next[step]
  for (const s of STEP_IDS) {
    if (s > step && next[s] === 'confirmed') next[s] = 'review'
  }
  Projects.setSteps(projectId, next, step)
  if (step <= 3) Lines.markDownstreamStale(projectId)
  emit({ type: 'step:update', projectId, stepStates: next, currentStep: step })
}

/** 任务开始/结束时的状态推进 */
export function markRunningStep(projectId: string, step: StepId): void {
  setStepState(projectId, step, 'running')
}

export function markReviewedStep(projectId: string, step: StepId): void {
  const project = Projects.get(projectId)
  if (!project) return
  const state = project.stepStates[step]
  if (state === 'confirmed') return
  setStepState(projectId, step, 'review')
}

export function markErrorStep(projectId: string, step: StepId): void {
  setStepState(projectId, step, 'error')
}

/** 步骤①产物变化后：分镜已被人工编辑，标记来源为 manual */
export function isConfirmed(project: ProjectDto, step: StepId): boolean {
  return project.stepStates[step] === 'confirmed'
}
