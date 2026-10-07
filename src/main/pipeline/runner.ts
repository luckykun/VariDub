/**
 * 流水线编排器（SPEC-001 §3 通用规则、§7.5、§7.7）。
 * 所有「跑一步 / 局部重跑」都经这里：门禁校验 → 建 Job → 状态推进 → 执行 → review/error。
 * 同一项目同一步骤只允许 1 个任务（避免产物竞争与重复计费）。
 */
import { existsSync } from 'node:fs'
import type { JobDto, LineDto, ProjectDto, ShotDto, StepId } from '../../shared/types'
import { STEP_IDS } from '../../shared/types'
import { emit } from '../events'
import { log } from '../logger'
import { cancelJob, createJob, finish, listJobs, markRunning, runningJobFor, setLogPath, type JobRecord } from '../jobs'
import { Artifacts, Lines, Projects, Shots } from '../db/repos'
import { projectPaths } from './paths'
import { markDone } from './checkpoints'
import { gateCheck, markErrorStep, markReviewedStep, markRunningStep, reopenStep } from './stateMachine'
import { queryTask, resumeTask } from '../bailian/asyncTask'
import { mockMode } from '../bailian/chat'
import { runStep1, type Step1Options } from './steps/step1'
import { runStep2, type Step2Options } from './steps/step2'
import { runStep3, type Step3Options } from './steps/step3'
import { dubOneLine, runStep4, type Step4Options } from './steps/step4'
import { renderOnly, rerunLowConsistency, runPilot, runStep5, type Step5Options } from './steps/step5'
import { runStep6, type Step6Options } from './steps/step6'
import { translateOneLine, regenerateAlts } from './steps/step3'

export interface StartOptions extends Step1Options, Step2Options, Step3Options, Step4Options, Step5Options, Step6Options {}

/** 启动整步：门禁不通过直接抛错（HTTP 层转 409） */
export async function startStep(projectId: string, step: StepId, opts: StartOptions = {}): Promise<JobDto> {
  const project = needProject(projectId)
  const gate = gateCheck(project, step)
  if (!gate.allowed) throw new GateError(gate.reason ?? '本步骤当前不可进入')
  const running = runningJobFor(projectId, step)
  if (running) throw new GateError(`步骤${step}已有任务在跑（${running.name}），请先取消或等待完成`)
  // 已确认的步骤重跑 = 自动「打开本步 + 下游退回 review」（P3：改上游比改下游便宜）
  if (project.stepStates[step] === 'confirmed') reopenStep(projectId, step)
  return launch(project, step, `步骤${step} 全量`, (job) => executeStep(project.id, step, opts, job))
}

/** 试跑 1 张关键帧（步骤⑤ 阶段①，两段式门禁 P2） */
export async function startPilot(projectId: string, opts: Step5Options & { shotId?: string | null } = {}): Promise<JobDto> {
  const project = needProject(projectId)
  assertGate(project, 5)
  return launch(project, 5, '步骤⑤ 关键帧试跑', (job) => runPilot(project, job, opts).then(() => undefined))
}

/** 重跑指定分镜（单分镜「重新生成」） */
export async function startShotRerun(projectId: string, shotIds: string[], opts: Step5Options = {}): Promise<JobDto> {
  const project = needProject(projectId)
  assertGate(project, 5)
  const shots = Shots.list(projectId).filter((s) => shotIds.includes(s.id))
  if (shots.length === 0) throw new GateError('分镜不存在')
  return launch(project, 5, `步骤⑤ 重跑 ${shots.length} 个分镜`, (job) => renderOnly(project, job, shots, opts).then(() => undefined))
}

/** 批量重跑低一致性分镜 */
export async function startLowConsistencyRerun(projectId: string, threshold = 0.75): Promise<JobDto> {
  const project = needProject(projectId)
  assertGate(project, 5)
  return launch(project, 5, '步骤⑤ 重跑低一致性分镜', (job) => rerunLowConsistency(project, job, threshold).then(() => undefined))
}

/** 单句重译 / 换备选 / 单句重配（人工密集环节的微重跑） */
export async function startLineAction(projectId: string, lineId: string, action: 'translate' | 'alts' | 'dub'): Promise<JobDto> {
  const project = needProject(projectId)
  const step: StepId = action === 'dub' ? 4 : 3
  assertGate(project, step)
  const line = Lines.get(lineId)
  if (!line) throw new GateError('句子不存在')
  const label = `${action === 'translate' ? '重译' : action === 'alts' ? '换备选' : '重配'}第 ${line.index + 1} 句`
  return launch(project, step, label, async (job) => {
    const result =
      action === 'translate'
        ? await translateOneLine(project, lineId)
        : action === 'alts'
          ? await regenerateAlts(project, lineId)
          : await dubOneLine(project, lineId)
    if (!result) throw new Error('句子不存在')
    job.dto.message = `第 ${result.index + 1} 句已更新`
  })
}

/** 取消任务 */
export function cancel(projectId: string, jobId: string): boolean {
  const ok = cancelJob(jobId)
  if (ok) log.info('runner', `请求取消 ${jobId}（项目 ${projectId}）`)
  return ok
}

export function jobsOf(projectId: string): JobDto[] {
  return listJobs(projectId)
}

/* ------------------------------------------------------------ 断点续跑 */

/**
 * 重启后先查未完成的云端任务（SPEC-001 §7.7-1）：
 * 成功但没下载 → 补下载并登记；失败/超时 → 清掉索引，让下一次重跑重新提交。
 */
export async function resumePendingCloudTasks(): Promise<{ checked: number; recovered: number; dropped: number }> {
  if (mockMode()) return { checked: 0, recovered: 0, dropped: 0 }
  let recovered = 0
  let dropped = 0
  const rows = Artifacts.pendingCloudTasks()
  for (const a of rows) {
    const taskId = a.taskId ?? (typeof a.meta.taskId === 'string' ? a.meta.taskId : null)
    if (!taskId) continue
    try {
      const outcome = await queryTaskSafe(taskId)
      if (outcome.status === 'SUCCEEDED') {
        const paths = projectPaths(a.projectId)
        const key = typeof a.meta.key === 'string' ? a.meta.key : ''
        const dest = typeof a.meta.dest === 'string' && a.meta.dest ? a.meta.dest : destFromKey(paths, key)
        const file = dest ? await resumeTask(taskId, dest) : null
        if (file) {
          recovered += 1
          adoptRecovered(a.projectId, key, file)
          log.info('runner', `断点续跑：补下载云端产物 ${file}`)
        }
      } else if (outcome.status === 'FAILED') {
        dropped += 1
      }
    } catch (err) {
      log.warn('runner', `断点续跑查询 ${taskId} 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (rows.length > 0) log.info('runner', `云端任务续跑：检查 ${rows.length}，补回 ${recovered}，失败 ${dropped}`)
  return { checked: rows.length, recovered, dropped }
}

async function queryTaskSafe(taskId: string): Promise<{ status: string; message: string | null }> {
  const o = await queryTask(taskId)
  return { status: o.status, message: o.message }
}

/** cloud_task 的产物目标路径由 key（<shotId>:keyframe|clip）反推 */
function destFromKey(paths: ReturnType<typeof projectPaths>, key: string): string {
  const [shotId, kind] = key.split(':')
  if (!shotId || !kind) return ''
  return kind === 'keyframe' ? paths.keyframeOf(shotId) : paths.clip3dOf(shotId)
}

/** 补回来的产物回写到分镜表，UI 与下游步骤能直接看到 */
function adoptRecovered(projectId: string, key: string, file: string): void {
  const [shotId, kind] = key.split(':')
  if (!shotId || !kind) return
  if (kind === 'keyframe') {
    Shots.patch(shotId, { frame3dPath: file })
    markDone(projectId, 5, 'keyframe', key, file, { resumed: true })
  } else if (kind === 'clip') {
    Shots.patch(shotId, { clip3dPath: file, acceptStatus: 'pending', error: null })
    markDone(projectId, 5, 'shot3d_clip', key, file, { resumed: true })
  }
}

/* ------------------------------------------------------------------ 内部 */

export class GateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GateError'
  }
}

function needProject(projectId: string): ProjectDto {
  const project = Projects.get(projectId)
  if (!project) throw new GateError('项目不存在')
  return project
}

function assertGate(project: ProjectDto, step: StepId): void {
  const gate = gateCheck(project, step)
  if (!gate.allowed) throw new GateError(gate.reason ?? '本步骤当前不可进入')
  const running = runningJobFor(project.id, step)
  if (running) throw new GateError(`步骤${step}已有任务在跑，请先取消或等待完成`)
}

/** 建任务 + 状态推进 + 异常收敛（错误写步骤状态，不让 promise 泄漏） */
function launch(project: ProjectDto, step: StepId, name: string, body: (job: JobRecord) => Promise<void>): JobDto {
  const job = createJob(project.id, step, name)
  const paths = projectPaths(project.id)
  setLogPath(job, paths.log(`step${step}`))
  markRunningStep(project.id, step)
  markRunning(job)
  job.promise = (async () => {
    try {
      await body(job)
      finish(job, job.cancelled ? 'cancelled' : 'succeeded')
      markReviewedStep(project.id, step)
      emit({ type: 'project:update', projectId: project.id })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const cancelled = job.cancelled || /已取消/.test(msg)
      finish(job, cancelled ? 'cancelled' : 'failed', msg)
      if (!cancelled) {
        markErrorStep(project.id, step)
        log.error('runner', `步骤${step} 失败：${msg}`)
      }
      emit({ type: 'project:update', projectId: project.id })
    }
  })()
  return job.dto
}

async function executeStep(projectId: string, step: StepId, opts: StartOptions, job: JobRecord): Promise<void> {
  const project = needProject(projectId)
  await (async () => {
    switch (step) {
      case 1:
        return runStep1(project, job, { model: opts.model, force: opts.force })
      case 2:
        return runStep2(project, job, { model: opts.model, reuseSeparation: opts.reuseSeparation })
      case 3:
        return runStep3(project, job, { model: opts.model, force: opts.force, batchSize: opts.batchSize })
      case 4:
        return runStep4(project, job, { model: opts.model, force: opts.force, includeUnconfirmed: opts.includeUnconfirmed })
      case 5:
        return runStep5(project, job, opts)
      case 6:
        return runStep6(project, job, opts)
      default:
        throw new GateError(`未知步骤 ${step}`)
    }
  })()
}

/** 供 UI 展示的每步概要（还差什么才能确认） */
export function stepSummary(project: ProjectDto): Array<{ step: StepId; state: ProjectDto['stepStates'][StepId]; hint: string }> {
  const shots = Shots.list(project.id)
  const lines = Lines.list(project.id)
  const hints: Record<StepId, string> = {
    1: `${shots.length} 个分镜`,
    2: `${lines.length} 句 / ${project.stats.speakerCount} 位说话人`,
    3: `${lines.filter((l) => l.confirmStatus === 'confirmed').length}/${lines.length} 句已确认`,
    4: `${project.stats.dubDone}/${lines.length} 句已配音`,
    5: `${project.stats.shot3dAccepted}/${shots.length} 个分镜已接受`,
    6: existsSync(projectPaths(project.id).finalDir) ? '可导出生成片' : '待合成'
  }
  return STEP_IDS.map((s) => ({ step: s, state: project.stepStates[s], hint: hints[s] }))
}

export function lineSnapshot(projectId: string): LineDto[] {
  return Lines.list(projectId)
}

export function shotSnapshot(projectId: string): ShotDto[] {
  return Shots.list(projectId)
}
