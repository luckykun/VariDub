/**
 * 项目与总览接口（SPEC-001 §4 项目列表 / §7.5）。
 * 导入即前置检查（时长/人声/画面三项），blocking 项不过不允许建项目。
 */
import { existsSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { ProjectDto, StepId } from '../../../shared/types'
import type { OverviewDto, ReportDto } from '../../../shared/api'
import { Artifacts, Lines, Projects, Shots, Speakers } from '../../db/repos'
import { ensureProjectDir } from '../../paths'
import { getSetting } from '../../db/repos/settings'
import { probe } from '../../media/ffmpeg'
import { gateCheck, validateStep } from '../../pipeline/stateMachine'
import { currentProduct, deviationReport } from '../../pipeline/steps/step6'
import { jobsOf, stepSummary } from '../../pipeline/runner'
import { gpuBusy } from '../../pipeline/gpuQueue'
import { cloudQueueState } from '../../bailian/asyncTask'
import { precheckFile, refreshFreeBytes, sidecarView } from '../dto'
import { GateError } from '../../pipeline/runner'
import { allowRoot } from '../app'
import { log } from '../../logger'

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get('/api/projects', async () => Projects.list())

  app.post('/api/precheck', async (req) => {
    const body = req.body as { filePath?: string }
    const filePath = (body.filePath ?? '').trim()
    if (!filePath) throw new GateError('没有文件路径')
    const result = await precheckFile(filePath)
    await refreshFreeBytes()
    return result
  })

  app.post('/api/projects', async (req) => {
    const body = req.body as { filePath?: string; name?: string }
    const filePath = (body.filePath ?? '').trim()
    if (!filePath || !existsSync(filePath)) throw new GateError(`视频文件不存在：${filePath}`)
    const check = await precheckFile(filePath)
    const blocked = check.items.filter((i) => i.blocking && !i.pass)
    if (!check.ok) {
      throw new GateError(`导入前置检查未通过：${blocked.map((b) => `${b.label}（${b.detail}）`).join('；')}`)
    }
    const meta = await probe(filePath)
    const project = Projects.create({
      name: (body.name ?? basename(filePath).replace(/\.[^.]+$/, '')).slice(0, 60),
      sourceVideoPath: filePath,
      durationMs: meta.durationMs,
      width: meta.width,
      height: meta.height
    })
    allowRoot(dirname(filePath))
    log.info('projects', `新建项目 ${project.id}「${project.name}」← ${filePath}（${Math.round(meta.durationMs / 1000)}s）`)
    return project
  })

  app.get('/api/projects/:id', async (req) => needProject(idOf(req.params)))

  app.get<{ Params: { id: string } }>('/api/projects/:id/overview', async (req) => {
    const project = needProject(req.params.id)
    await refreshFreeBytes()
    const steps = stepSummary(project).map((s) => {
      const gate = gateCheck(project, s.step)
      return { ...s, locked: !gate.allowed, reason: gate.reason }
    })
    const gate = {} as Record<StepId, ReturnType<typeof validateStep>>
    for (const s of [1, 2, 3, 4, 5, 6] as StepId[]) gate[s] = validateStep(project, s)
    const overview: OverviewDto = {
      project,
      shots: Shots.list(project.id),
      lines: Lines.list(project.id),
      speakers: Speakers.list(project.id),
      steps,
      gate,
      jobs: jobsOf(project.id),
      product: currentProduct(project.id),
      gpu: gpuBusy(),
      cloud: cloudQueueState(),
      sidecar: sidecarView(),
      artifacts: Artifacts.list(project.id)
    }
    return overview
  })

  app.patch('/api/projects/:id', async (req) => {
    const id = idOf(req.params)
    needProject(id)
    const body = req.body as { name?: string }
    if (body.name?.trim()) Projects.patch(id, { name: body.name.trim().slice(0, 60) })
    return needProject(id)
  })

  app.delete('/api/projects/:id', async (req) => {
    const id = idOf(req.params)
    needProject(id)
    const body = (req.body ?? {}) as { purgeFiles?: boolean }
    const dir = join(getSetting('storage.workspace_root'), id)
    Projects.remove(id)
    if (body.purgeFiles && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      log.info('projects', `已删除项目 ${id} 并清空工作区 ${dir}`)
    }
    return { ok: true, purged: body.purgeFiles === true }
  })

  app.get('/api/projects/:id/report', async (req) => {
    const project = needProject(idOf(req.params))
    const product = currentProduct(project.id)
    const report: ReportDto = {
      projectId: project.id,
      generatedAt: new Date().toISOString(),
      summary: {
        lines: project.stats.lineCount,
        dubbed: project.stats.dubDone,
        lipsync_done: Lines.list(project.id).filter((l) => l.lipsyncStatus === 'done').length,
        lipsync_skipped: Lines.list(project.id).filter((l) => l.lipsyncStatus !== 'done').length,
        red: deviationReport(Lines.list(project.id)).filter((r) => r.flag === 'red').length,
        yellow: deviationReport(Lines.list(project.id)).filter((r) => r.flag === 'yellow').length
      },
      lines: deviationReport(Lines.list(project.id))
    }
    return { ...report, product }
  })

  app.get('/api/projects/:id/artifacts', async (req) => {
    const id = idOf(req.params)
    needProject(id)
    const query = req.query as { step?: string }
    const step = query.step ? (Number(query.step) as StepId) : undefined
    return Artifacts.list(id, step)
  })
}

function idOf(params: unknown): string {
  return (params as { id: string }).id
}

function needProject(id: string): ProjectDto {
  const project = Projects.get(id)
  if (!project) throw new GateError(`项目不存在：${id}`)
  ensureProjectDir(getSetting('storage.workspace_root'), id)
  allowRoot(project.workspaceDir)
  allowRoot(dirname(project.sourceVideoPath))
  return project
}
