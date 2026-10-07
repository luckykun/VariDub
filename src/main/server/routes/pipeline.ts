/**
 * 流水线接口（SPEC-001 §3 通用规则、§7.5）：跑一步 / 确认 / 回改 / 取消 / 局部重跑 / 导出。
 * 门禁不通过返回 409（GateError → app.ts 的 error handler）。
 */
import type { FastifyInstance } from 'fastify'
import type { ProjectDto, ShotDto, StepId } from '../../../shared/types'
import type { ConfirmResponse, StepRunRequest } from '../../../shared/api'
import { Lines, Projects, Shots } from '../../db/repos'
import { blockReasons, confirmStep, gateCheck, reopenStep, validateStep } from '../../pipeline/stateMachine'
import {
  GateError,
  cancel,
  jobsOf,
  startLineAction,
  startLowConsistencyRerun,
  startPilot,
  startShotRerun,
  startStep,
  type StartOptions
} from '../../pipeline/runner'
import { currentProduct, exportDirOf, exportFinal } from '../../pipeline/steps/step6'

export function registerPipelineRoutes(app: FastifyInstance): void {
  app.post('/api/projects/:id/steps/:step/run', async (req) => {
    const { id, step } = req.params as { id: string; step: string }
    needProject(id)
    const body = (req.body ?? {}) as StepRunRequest
    return startStep(id, parseStep(step), toOptions(body))
  })

  app.get('/api/projects/:id/steps/:step/gate', async (req) => {
    const { id, step } = req.params as { id: string; step: string }
    const project = needProject(id)
    const parsed = parseStep(step)
    const gate = gateCheck(project, parsed)
    const issues = validateStep(project, parsed)
    return { allowed: gate.allowed, reason: gate.reason, issues, blocking: blockReasons(issues) }
  })

  app.post('/api/projects/:id/steps/:step/confirm', async (req): Promise<ConfirmResponse> => {
    const { id, step } = req.params as { id: string; step: string }
    const project = needProject(id)
    const parsed = parseStep(step)
    const body = (req.body ?? {}) as { force?: boolean }
    const result = confirmStep(project.id, parsed, body.force === true)
    if (!result.ok) throw new GateError(`还不能确认：${blockReasons(result.issues).join('；')}`)
    return { ok: true, issues: result.issues }
  })

  app.post('/api/projects/:id/steps/:step/reopen', async (req) => {
    const { id, step } = req.params as { id: string; step: string }
    const project = needProject(id)
    reopenStep(project.id, parseStep(step))
    return needProject(project.id)
  })

  app.get('/api/projects/:id/jobs', async (req) => jobsOf((req.params as { id: string }).id))

  app.post('/api/projects/:id/jobs/:jobId/cancel', async (req) => {
    const { id, jobId } = req.params as { id: string; jobId: string }
    needProject(id)
    const job = jobsOf(id).find((j) => j.id === jobId)
    if (!job) throw new GateError('任务不存在或已结束')
    return { ok: cancel(id, jobId), job }
  })

  /* ------------------------------------------------------------ 步骤⑤ */

  app.post('/api/projects/:id/step5/pilot', async (req) => {
    const { id } = req.params as { id: string }
    needProject(id)
    const body = (req.body ?? {}) as StepRunRequest & { shotId?: string | null }
    return startPilot(id, { ...toOptions(body), shotId: body.shotId ?? null })
  })

  app.post('/api/projects/:id/step5/shots', async (req) => {
    const { id } = req.params as { id: string }
    needProject(id)
    const body = (req.body ?? {}) as StepRunRequest & { shotIds?: string[] }
    const ids = body.shotIds ?? []
    if (ids.length === 0) throw new GateError('没有指定分镜')
    return startShotRerun(id, ids, toOptions(body))
  })

  app.post('/api/projects/:id/step5/rerun-low', async (req) => {
    const { id } = req.params as { id: string }
    needProject(id)
    const body = (req.body ?? {}) as { threshold?: number }
    return startLowConsistencyRerun(id, body.threshold ?? 0.75)
  })

  app.post('/api/projects/:id/shots/accept', async (req) => {
    const id = (req.params as { id: string }).id
    needProject(id)
    const body = (req.body ?? {}) as { shotIds?: string[]; from?: ShotDto['acceptStatus'][] }
    const from = body.from ?? ['pending', 'queued', 'failed']
    const shots = Shots.list(id)
    const picked = body.shotIds?.length ? shots.filter((s) => body.shotIds?.includes(s.id)) : shots.filter((s) => from.includes(s.acceptStatus))
    const withClip = picked.filter((s) => s.clip3dPath)
    if (withClip.length === 0) throw new GateError('没有可接受的分镜（缺少 3D 片段）')
    Shots.setAcceptStatus(withClip.map((s) => s.id), 'accepted')
    return { accepted: withClip.length, shots: Shots.list(id) }
  })

  /* ------------------------------------------------------------ 步骤⑥ */

  app.post('/api/projects/:id/step6/export', async (req) => {
    const id = (req.params as { id: string }).id
    const project = needProject(id)
    const body = (req.body ?? {}) as { destDir?: string; name?: string | null }
    const dir = (body.destDir ?? '').trim() || exportDirOf()
    if (!dir) throw new GateError('没有导出目录：请到设置页指定导出文件夹')
    const exported = exportFinal(project, dir, body.name ?? null)
    return { exportedTo: exported, product: currentProduct(id) }
  })

  /* -------------------------------------------------- 单句微重跑（③④） */

  app.post('/api/lines/:lineId/action', async (req) => {
    const lineId = (req.params as { lineId: string }).lineId
    const line = Lines.get(lineId)
    if (!line) throw new GateError('句子不存在')
    const body = (req.body ?? {}) as { action?: 'translate' | 'alts' | 'dub' }
    const action = body.action
    if (action !== 'translate' && action !== 'alts' && action !== 'dub') throw new GateError('未知操作')
    return startLineAction(line.projectId, lineId, action)
  })
}

function parseStep(raw: string): StepId {
  const n = Number(raw)
  if (n !== 1 && n !== 2 && n !== 3 && n !== 4 && n !== 5 && n !== 6) throw new GateError(`未知步骤：${raw}`)
  return n
}

function toOptions(body: StepRunRequest): StartOptions {
  return { ...body }
}

function needProject(id: string): ProjectDto {
  const project = Projects.get(id)
  if (!project) throw new GateError(`项目不存在：${id}`)
  return project
}
