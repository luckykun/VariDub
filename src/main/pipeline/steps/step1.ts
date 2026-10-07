/**
 * 步骤① 视频解析（SPEC-001 §3.1）。
 * 实现策略：本地 ffmpeg 场景检测给出「候选切点」（免费且稳），云端视觉模型在候选切点约束下
 * 定稿分镜边界并输出场景描述/出镜人物；云端失败自动降级为纯本地切分（PySceneDetect 兜底位）。
 * 这样既保证分镜表一定落在真实镜头切换附近，也把视觉调用压到 1 次/项目（<¥1）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { JobRecord } from '../../jobs'
import { throwIfCancelled } from '../../jobs'
import type { ProjectDto, ShotDto } from '../../../shared/types'
import { emit } from '../../events'
import { Shots } from '../../db/repos'
import { ensureProjectDir } from '../../paths'
import { getSetting } from '../../db/repos/settings'
import { extractFrame, probe } from '../../media/ffmpeg'
import { detectSceneChanges } from '../analyzers'
import { projectPaths } from '../paths'
import { writeShotsCheckpoint } from '../checkpoints'
import { makeCtx, DEFAULT_SHOT_PROMPT, loadPrompt } from './common'
import { chatJson, mockMode } from '../../bailian/chat'
import { resolve as resolveRoute } from '../../bailian/timeRouter'
import { newId } from '../../util/id'
import { log } from '../../logger'

export interface Step1Options {
  /** 手动指定模型（覆盖时段路由） */
  model?: string | null
  force?: boolean
}

interface VlShot {
  start_ms?: number
  end_ms?: number
  scene_desc?: string
  persons?: string[]
}

export async function runStep1(project: ProjectDto, job: JobRecord, opts: Step1Options = {}): Promise<ShotDto[]> {
  const paths = projectPaths(project.id)
  ensureProjectDir(getSetting('storage.workspace_root'), project.id)
  const ctx = makeCtx(project, job, paths)
  const framesDir = join(paths.root, 'frames')
  if (existsSync(framesDir)) rmSync(framesDir, { recursive: true, force: true })

  ctx.progress(0.05, '读取视频元信息')
  const meta = await probe(project.sourceVideoPath)
  const durationMs = meta.durationMs || project.durationMs

  ctx.progress(0.12, '本地镜头切换检测（ffmpeg 场景差）')
  const candidates = await detectSceneChanges(project.sourceVideoPath, durationMs)
  const cutPoints = dedupeSorted([0, ...candidates.map((c) => c.atMs), durationMs], durationMs)
  throwIfCancelled(job)

  ctx.progress(0.28, `抽帧 ${Math.min(framePlan(cutPoints).length, 48)} 张关键帧`)
  const frames = await extractKeyFrames(project.sourceVideoPath, framesDir, cutPoints, durationMs)
  ctx.log(`抽帧完成：${frames.length} 张`)

  let shots: ShotDto[]
  let source: ShotDto['source'] = 'pyscenedetect'
  if (mockMode()) {
    ctx.progress(0.6, 'Mock 模式：使用本地检测切点生成分镜')
    shots = buildShotsFromCuts(cutPoints, durationMs, project.id)
    source = 'pyscenedetect'
  } else {
    try {
      ctx.progress(0.5, '云端视觉理解：分镜定稿 + 场景描述')
      const route = resolveRoute('shot_analysis')
      const usedModel = opts.model && opts.model !== 'auto' ? opts.model : route.model
      ctx.log(`生效模型：${usedModel}（${route.badge}）`)
      const parsed = await analyzeWithVl(usedModel, frames, cutPoints, durationMs)
      shots = repairShots(parsed, durationMs, project.id)
      source = 'vl'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('step1', `云端分镜失败，降级本地：${msg}`)
      ctx.log(`云端失败已降级本地分镜检测：${msg}`)
      shots = buildShotsFromCuts(cutPoints, durationMs, project.id)
      source = 'pyscenedetect'
    }
  }

  ctx.progress(0.72, '生成分镜缩略图')
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i]
    const mid = Math.min(durationMs - 100, Math.round((shot.startMs + shot.endMs) / 2))
    try {
      const file = join(framesDir, `shot_${String(shot.index).padStart(3, '0')}.jpg`)
      await extractFrame(project.sourceVideoPath, Math.max(0, mid), file, 480)
      shot.thumbPath = file
    } catch {
      shot.thumbPath = null
    }
    ctx.progress(0.72 + (0.2 * (i + 1)) / Math.max(1, shots.length), `缩略图 ${i + 1}/${shots.length}`)
  }

  // 保留上一次的分镜编辑（试跑/接受状态）：按 index 对齐
  const prev = Shots.list(project.id)
  if (prev.length > 0 && !opts.force) {
    for (const s of shots) {
      const old = prev.find((p) => p.index === s.index)
      if (old) {
        s.acceptStatus = old.acceptStatus === 'failed' || old.acceptStatus === 'pending' ? 'pending' : old.acceptStatus
        s.styleId = old.styleId
        s.isPilot = old.isPilot
      }
    }
  }

  Shots.replaceAll(project.id, shots)
  writeShotsCheckpoint(project.id, shots)
  ctx.progress(1, `分镜表完成：${shots.length} 段（${source === 'vl' ? '云端视觉' : '本地兜底'}）`)
  emit({ type: 'shots:update', projectId: project.id })
  emit({ type: 'project:update', projectId: project.id })
  return shots
}

function dedupeSorted(values: number[], durationMs: number): number[] {
  const sorted = [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => a - b)
  const filtered = sorted.filter((v) => v > 0 && v < durationMs)
  // 合并过近切点（<800ms 无法成段）
  const merged: number[] = [0]
  for (const v of filtered) {
    if (v - merged[merged.length - 1] >= 800) merged.push(v)
  }
  if (durationMs - merged[merged.length - 1] >= 800) merged.push(durationMs)
  else merged[merged.length - 1] = durationMs
  if (merged.length < 2) merged.splice(1, 0, durationMs)
  return merged
}

function framePlan(cuts: number[]): number[] {
  const times: number[] = []
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i]
    const end = cuts[i + 1]
    times.push(Math.round(start + (end - start) * 0.25), Math.round(start + (end - start) * 0.75))
  }
  return times
}

interface FrameRef {
  file: string
  atMs: number
}

async function extractKeyFrames(video: string, framesDir: string, cuts: number[], durationMs: number): Promise<FrameRef[]> {
  const plan = framePlan(cuts)
  const limited = plan.length > 48 ? evenlySample(plan, 48) : plan
  const refs: FrameRef[] = []
  let idx = 0
  for (const atMs of limited) {
    const file = join(framesDir, `f${String(idx).padStart(3, '0')}_${atMs}.jpg`)
    try {
      await extractFrame(video, Math.min(Math.max(0, atMs), Math.max(0, durationMs - 100)), file, 640)
      refs.push({ file, atMs })
    } catch {
      /* 单帧失败不阻断 */
    }
    idx += 1
  }
  return refs
}

function evenlySample<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return arr
  const step = arr.length / count
  const out: T[] = []
  for (let i = 0; i < count; i += 1) out.push(arr[Math.floor(i * step)])
  return out
}

function toDataUrl(file: string): string {
  return `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`
}

async function analyzeWithVl(model: string, frames: FrameRef[], cuts: number[], durationMs: number): Promise<VlShot[]> {
  const system = loadPrompt('shot_analysis', DEFAULT_SHOT_PROMPT)
  const user = `视频总时长 ${durationMs} ms。
本地镜头检测给出的候选切点（ms）：${JSON.stringify(cuts)}
以下按时间顺序给出 ${frames.length} 张抽帧，每张对应时间码：${JSON.stringify(frames.map((f) => f.atMs))}
请输出分镜表：start_ms / end_ms 必须取自候选切点集合（允许删掉误检的切点，不允许发明新的切点），相邻分镜首尾相接覆盖 0 到 ${durationMs}。`
  const images = frames.map((f) => toDataUrl(f.file))
  const parsed = await chatJson<{ shots?: VlShot[] }>({
    model,
    system,
    user,
    images,
    temperature: 0.2,
    maxTokens: 4096,
    scope: 'step1'
  })
  if (!Array.isArray(parsed.shots) || parsed.shots.length === 0) throw new Error('视觉模型未返回分镜数组')
  return parsed.shots
}

/** 边界修复：强制首尾相接 + 覆盖全片 + 最短时长 */
function repairShots(raw: VlShot[], durationMs: number, projectId: string): ShotDto[] {
  const sorted = [...raw]
    .map((s) => ({
      startMs: Math.max(0, Math.min(durationMs, Math.round(Number(s.start_ms ?? 0)))),
      endMs: Math.max(0, Math.min(durationMs, Math.round(Number(s.end_ms ?? 0))), Math.round(Number(s.start_ms ?? 0)) + 800),
      sceneDesc: String(s.scene_desc ?? '').trim(),
      persons: Array.isArray(s.persons) ? s.persons.map(String).slice(0, 8) : []
    }))
    .sort((a, b) => a.startMs - b.startMs)
  if (sorted.length === 0) return buildShotsFromCuts([0, durationMs], durationMs, projectId)
  sorted[0].startMs = 0
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const gap = sorted[i + 1].startMs - sorted[i].endMs
    if (gap > 0) sorted[i].endMs = sorted[i + 1].startMs
    else if (gap < 0) sorted[i].endMs = Math.max(sorted[i].startMs + 800, sorted[i + 1].startMs)
  }
  sorted[sorted.length - 1].endMs = durationMs
  return sorted.map((s, i) => ({
    id: newId('sht'),
    projectId,
    index: i,
    startMs: s.startMs,
    endMs: Math.max(s.startMs + 800, s.endMs),
    sceneDesc: s.sceneDesc,
    persons: s.persons,
    thumbPath: null,
    frame3dPath: null,
    clip3dPath: null,
    styleId: getSetting('style.preset'),
    consistencyScore: null,
    acceptStatus: 'pending',
    source: 'vl',
    error: null,
    isPilot: false
  }))
}

function buildShotsFromCuts(cuts: number[], durationMs: number, projectId: string): ShotDto[] {
  const points = cuts.length >= 2 ? cuts : [0, durationMs]
  return points.slice(0, -1).map((start, i) => ({
    id: newId('sht'),
    projectId,
    index: i,
    startMs: start,
    endMs: points[i + 1],
    sceneDesc: `分镜 ${i + 1}（本地检测，待补充描述）`,
    persons: [],
    thumbPath: null,
    frame3dPath: null,
    clip3dPath: null,
    styleId: getSetting('style.preset'),
    consistencyScore: null,
    acceptStatus: 'pending',
    source: 'pyscenedetect',
    error: null,
    isPilot: false
  }))
}
