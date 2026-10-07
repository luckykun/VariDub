/**
 * 步骤⑤ 3D 画面重绘（SPEC-001 §3.5，两段式门禁 P2）。
 * 阶段①试跑：1 个代表性分镜 → wan2.7-image-pro 重绘关键帧（几分钱）→ 人工对比确认风格。
 * 阶段②全量：逐分镜「关键帧重绘 + happyhorse-1.1-i2v 图生视频」→ 3D 分镜片段。
 * 两者都是异步任务：taskId 落 Artifact 表（断点续跑不重复计费，§7.7-1），并发 ≤2。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { JobRecord } from '../../jobs'
import { throwIfCancelled } from '../../jobs'
import type { ProjectDto, ShotDto } from '../../../shared/types'
import { STYLE_PRESETS } from '../../../shared/models'
import { emit } from '../../events'
import { Artifacts, Shots } from '../../db/repos'
import { getNum, getSetting, isMock } from '../../db/repos/settings'
import { runTask, type AsyncTaskSpec } from '../../bailian/asyncTask'
import { mockClipFromKeyframe, mockKeyframe } from '../../bailian/mock'
import { mockMode } from '../../bailian/chat'
import { extractFrame, probe } from '../../media/ffmpeg'
import { frameConsistency } from '../analyzers'
import { projectPaths } from '../paths'
import { clearDone, doneKeys, markDone, writeRenderCheckpoint, type RenderManifestRow } from '../checkpoints'
import { makeCtx } from './common'
import { log } from '../../logger'

export interface StyleOptions {
  styleId?: string
  /** 人脸一致性强度 0-1（默认取设置 style.face_consistency） */
  consistency?: number
  keyframeModel?: string | null
  motionModel?: string | null
}

export interface Step5Options extends StyleOptions {
  /** 只补跑缺产物的分镜（默认）；false 时全量重绘 */
  onlyMissing?: boolean
  /** 换风格/重跑时清掉关键帧与片段索引 */
  resetClips?: boolean
  concurrency?: number
}

const KEYFRAME_KIND = 'keyframe' as const
const CLIP_KIND = 'shot3d_clip' as const

/** 阶段①：试跑 1 张关键帧（不做动态化），供人工确认风格 */
export async function runPilot(project: ProjectDto, job: JobRecord, opts: Step5Options & { shotId?: string | null } = {}): Promise<ShotDto> {
  const paths = projectPaths(project.id)
  const ctx = makeCtx(project, job, paths)
  const shots = Shots.list(project.id)
  if (shots.length === 0) throw new Error('请先完成步骤①')
  const shot = shots.find((s) => s.id === opts.shotId) ?? shots.find((s) => s.isPilot) ?? shots[Math.floor(shots.length / 2)]
  const style = resolveStyle(opts)

  ctx.progress(0.1, `试跑分镜 #${shot.index + 1}：抽取原始帧`)
  const original = await ensureOriginalFrame(project, shot, paths.frameOf(shot.id))
  ctx.progress(0.25, `云端重绘关键帧（${style.label} · ${keyframeModel(opts)}）`)

  const keyframe = paths.keyframeOf(shot.id)
  if (mockMode()) {
    await mockKeyframe(original, keyframe, style.id)
  } else {
    const spec = keyframeSpec(project, shot, original, style)
    await runTask({
      spec,
      destPath: keyframe,
      label: `关键帧 分镜#${shot.index + 1}`,
      onSubmitted: (taskId) => trackTask(project.id, `${shot.id}:keyframe`, taskId, 'submitted'),
      onTick: (outcome, elapsed) => ctx.log(`关键帧任务 ${outcome.status}（${Math.round(elapsed / 1000)}s）`)
    })
    if (!existsSync(keyframe)) throw new Error('关键帧下载失败：任务成功但未落盘')
  }

  Shots.patch(shot.id, { frame3dPath: keyframe, isPilot: true, styleId: style.id })
  markDone(project.id, 5, KEYFRAME_KIND, `${shot.id}:keyframe`, keyframe, { pilot: true, style: style.id })
  trackTask(project.id, `${shot.id}:keyframe`, null, 'succeeded')
  ctx.progress(1, '关键帧已生成：请对比原帧与 3D 帧，确认后开始全量渲染')
  emit({ type: 'shots:update', projectId: project.id })
  return Shots.get(shot.id) ?? { ...shot, frame3dPath: keyframe, isPilot: true }
}

/** 阶段②：全量渲染（跳过已完成分镜，断点续跑） */
export async function runStep5(project: ProjectDto, job: JobRecord, opts: Step5Options = {}): Promise<ShotDto[]> {
  const paths = projectPaths(project.id)
  const ctx = makeCtx(project, job, paths)
  const shots = Shots.list(project.id)
  if (shots.length === 0) throw new Error('请先完成步骤①')

  const style = resolveStyle(opts)
  if (!mockMode() && opts.onlyMissing !== false && !shots.some((s) => s.isPilot && s.acceptStatus === 'accepted')) {
    throw new Error('请先试跑 1 张关键帧并「接受」该分镜，确认风格后再全量渲染（改风格越早越便宜）')
  }
  if (opts.resetClips) {
    clearDone(project.id, CLIP_KIND)
    Shots.resetRender(project.id)
    ctx.log('已清空渲染产物（换风格重跑）')
  }

  const doneClips = doneKeys(project.id, CLIP_KIND)
  const doneFrames = doneKeys(project.id, KEYFRAME_KIND)
  const targets = shots.filter((s) => {
    const clipKey = `${s.id}:clip`
    if (!opts.onlyMissing && !doneClips.has(clipKey)) return true
    if (opts.onlyMissing === false) return true
    return !doneClips.has(clipKey) || s.acceptStatus === 'failed' || s.acceptStatus === 'pending'
  })
  const list = opts.onlyMissing === false ? shots : targets
  if (list.length === 0) {
    ctx.progress(1, '所有分镜已有 3D 片段，无需重绘')
    return shots
  }

  const concurrency = Math.max(1, Math.min(2, opts.concurrency ?? (getNum('render.concurrency') || 2)))
  ctx.log(`全量渲染：${list.length} 个分镜 · 并发 ${concurrency} · 风格 ${style.label} · 一致性 ${style.consistency}`)
  const size = await exportSize(project)
  const rows: RenderManifestRow[] = []
  let finished = 0
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= list.length) return
      const shot = list[i]
      throwIfCancelled(job)
      const clipKey = `${shot.id}:clip`
      const frameKey = `${shot.id}:keyframe`
      const clipPath = paths.clip3dOf(shot.id)
      try {
        if (doneClips.has(clipKey) && existsSync(clipPath)) {
          ctx.log(`分镜#${shot.index + 1} 已有产物，跳过（不重复计费）`)
          rows.push(rowOf(shot, clipPath, 'skipped'))
        } else {
          Shots.patch(shot.id, { acceptStatus: 'rendering', error: null })
          const original = await ensureOriginalFrame(project, shot, paths.frameOf(shot.id))
          let keyframe = paths.keyframeOf(shot.id)
          if (!doneFrames.has(frameKey) || !existsSync(keyframe)) {
            ctx.progress(0.05 + (0.4 * (i + 1)) / list.length, `分镜#${shot.index + 1} 关键帧`)
            if (mockMode()) {
              await mockKeyframe(original, keyframe, style.id)
              // Mock 也要记产物索引：否则断点续跑会重复生成，产物清单也永远为空
              markDone(project.id, 5, KEYFRAME_KIND, frameKey, keyframe, { style: style.id, mock: true })
            } else {
              await runTask({
                spec: keyframeSpec(project, shot, original, style),
                destPath: keyframe,
                label: `关键帧 分镜#${shot.index + 1}`,
                existingTaskId: pendingTaskId(project.id, frameKey),
                onSubmitted: (taskId) => trackTask(project.id, frameKey, taskId, 'submitted')
              })
              markDone(project.id, 5, KEYFRAME_KIND, frameKey, keyframe, { style: style.id })
              trackTask(project.id, frameKey, null, 'succeeded')
            }
          }
          if (!existsSync(keyframe)) throw new Error('关键帧缺失')

          ctx.progress(0.45 + (0.45 * (i + 1)) / list.length, `分镜#${shot.index + 1} 动态化（图生视频）`)
          if (mockMode()) {
            await mockClipFromKeyframe(keyframe, clipPath, shot.endMs - shot.startMs, size)
            markDone(project.id, 5, CLIP_KIND, clipKey, clipPath, { style: style.id, mock: true })
          } else {
            await runTask({
              spec: motionSpec(project, shot, keyframe, style),
              destPath: clipPath,
              label: `动态化 分镜#${shot.index + 1}`,
              existingTaskId: pendingTaskId(project.id, clipKey),
              onSubmitted: (taskId) => trackTask(project.id, clipKey, taskId, 'submitted'),
              onTick: (outcome, elapsed) => ctx.log(`分镜#${shot.index + 1} 动态任务 ${outcome.status}（${Math.round(elapsed / 1000)}s）`)
            })
            if (!existsSync(clipPath)) throw new Error('片段下载失败')
            markDone(project.id, 5, CLIP_KIND, clipKey, clipPath, { style: style.id })
            trackTask(project.id, clipKey, null, 'succeeded')
          }
          const score = await frameConsistency(original, keyframe).catch(() => null)
          Shots.patch(shot.id, {
            frame3dPath: keyframe,
            clip3dPath: clipPath,
            consistencyScore: score,
            styleId: style.id,
            // 渲染完成 → 等待人工接受（绿）；门禁要求全部 accepted
            acceptStatus: 'pending',
            error: null
          })
          rows.push({ shot_id: shot.id, index: shot.index, keyframe, clip: clipPath, consistency: score, status: 'rendered', task_id: null, error: null })
          ctx.log(`分镜#${shot.index + 1} 完成（一致性 ${score ?? '未知'}）`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('step5', `分镜#${shot.index + 1} 渲染失败：${msg}`)
        Shots.patch(shot.id, { acceptStatus: 'failed', error: msg.slice(0, 300) })
        rows.push({ shot_id: shot.id, index: shot.index, keyframe: null, clip: null, consistency: null, status: 'failed', task_id: null, error: msg.slice(0, 300) })
      }
      finished += 1
      ctx.progress(0.05 + (0.9 * finished) / list.length, `已完成 ${finished}/${list.length} 个分镜`)
      emit({ type: 'shots:update', projectId: project.id })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  writeRenderCheckpoint(project.id, rows.sort((a, b) => a.index - b.index))
  const failed = rows.filter((r) => r.status === 'failed').length
  ctx.progress(1, `渲染结束：${rows.length} 个分镜（失败 ${failed}）`)
  emit({ type: 'shots:update', projectId: project.id })
  emit({ type: 'project:update', projectId: project.id })
  return Shots.list(project.id)
}

/** 批量重跑低一致性分镜（§3.5 用户操作） */
export async function rerunLowConsistency(project: ProjectDto, job: JobRecord, threshold = 0.75): Promise<ShotDto[]> {
  const low = Shots.list(project.id).filter((s) => s.consistencyScore !== null && s.consistencyScore < threshold)
  if (low.length === 0) throw new Error(`没有一致性低于 ${threshold} 的分镜`)
  const ids = new Set(low.map((s) => s.id))
  const paths = projectPaths(project.id)
  for (const s of low) {
    if (s.clip3dPath && existsSync(s.clip3dPath)) rmSync(s.clip3dPath, { force: true })
    clearDone(project.id, CLIP_KIND)
  }
  Shots.patchMany([...ids], { acceptStatus: 'queued', error: null })
  emit({ type: 'shots:update', projectId: project.id })
  const ctx = makeCtx(project, job, paths)
  ctx.log(`重跑低一致性分镜：${low.length} 个（<${threshold}）`)
  // 只渲染这些：借用 onlyMissing=false 后按 ids 过滤
  return renderOnly(project, job, low)
}

/** 只渲染指定分镜集合（单分镜「重新生成」与批量重跑共用） */
export async function renderOnly(project: ProjectDto, job: JobRecord, shots: ShotDto[], opts: Step5Options = {}): Promise<ShotDto[]> {
  const paths = projectPaths(project.id)
  const ctx = makeCtx(project, job, paths)
  const style = resolveStyle(opts)
  const size = await exportSize(project)
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i]
    throwIfCancelled(job)
    const clipKey = `${shot.id}:clip`
    const frameKey = `${shot.id}:keyframe`
    try {
      Shots.patch(shot.id, { acceptStatus: 'rendering', error: null })
      const original = await ensureOriginalFrame(project, shot, paths.frameOf(shot.id))
      const keyframe = paths.keyframeOf(shot.id)
      if (mockMode()) await mockKeyframe(original, keyframe, style.id)
      else {
        await runTask({
          spec: keyframeSpec(project, shot, original, style),
          destPath: keyframe,
          label: `关键帧 分镜#${shot.index + 1}`,
          existingTaskId: pendingTaskId(project.id, frameKey),
          onSubmitted: (taskId) => trackTask(project.id, frameKey, taskId, 'submitted')
        })
        trackTask(project.id, frameKey, null, 'succeeded')
      }
      markDone(project.id, 5, KEYFRAME_KIND, frameKey, keyframe, { style: style.id })
      const clipPath = paths.clip3dOf(shot.id)
      if (existsSync(clipPath)) rmSync(clipPath, { force: true })
      if (mockMode()) await mockClipFromKeyframe(keyframe, clipPath, shot.endMs - shot.startMs, size)
      else {
        await runTask({
          spec: motionSpec(project, shot, keyframe, style),
          destPath: clipPath,
          label: `动态化 分镜#${shot.index + 1}`,
          onSubmitted: (taskId) => trackTask(project.id, clipKey, taskId, 'submitted')
        })
        trackTask(project.id, clipKey, null, 'succeeded')
      }
      markDone(project.id, 5, CLIP_KIND, clipKey, clipPath, { style: style.id })
      const score = await frameConsistency(original, keyframe).catch(() => null)
      Shots.patch(shot.id, { frame3dPath: keyframe, clip3dPath: clipPath, consistencyScore: score, styleId: style.id, acceptStatus: 'pending' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      Shots.patch(shot.id, { acceptStatus: 'failed', error: msg.slice(0, 300) })
    }
    ctx.progress((i + 1) / shots.length, `重跑 ${i + 1}/${shots.length}`)
    emit({ type: 'shots:update', projectId: project.id })
  }
  writeRenderCheckpoint(project.id, Shots.list(project.id).map((s) => rowOf(s, s.clip3dPath ?? '', s.acceptStatus)))
  return Shots.list(project.id)
}

/* --------------------------------------------------------------- 内部工具 */

interface ResolvedStyle {
  id: string
  label: string
  consistency: number
  prompt: string
}

function resolveStyle(opts: StyleOptions): ResolvedStyle {
  const id = opts.styleId ?? getSetting('style.preset') ?? 'pixar'
  const preset = STYLE_PRESETS.find((p) => p.id === id) ?? STYLE_PRESETS[0]
  const consistency = opts.consistency ?? getNum('style.face_consistency') ?? 0.82
  return { id: preset.id, label: preset.label, consistency: clamp01(consistency), prompt: STYLE_PROMPTS[preset.id] ?? STYLE_PRESETS[0].label }
}

const STYLE_PROMPTS: Record<string, string> = {
  pixar: '皮克斯式 3D 动画渲染：柔和次表面散射皮肤、电影级三点打光、略微夸张的五官比例、干净的场景几何与材质细节',
  anime: '日系动漫 3D 渲染：赛璐璐描边、体积光与镜头光晕、明亮饱和的色彩、头发分片建模',
  claymation: '黏土定格动画质感：黏土材质指纹与压痕、柔和工作室灯光、手工感边缘、略微不规则的几何'
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.82
  return Math.max(0, Math.min(1, v))
}

function keyframeModel(opts: StyleOptions): string {
  return opts.keyframeModel && opts.keyframeModel !== 'auto' ? opts.keyframeModel : getSetting('route.stage5_keyframe.model')
}

function motionModel(opts: StyleOptions): string {
  return opts.motionModel && opts.motionModel !== 'auto' ? opts.motionModel : getSetting('route.stage5_motion.model')
}

/** 关键帧重绘任务：以原始帧为结构基准，人脸一致性强度控制「像不像原片」 */
function keyframeSpec(project: ProjectDto, shot: ShotDto, originalFrame: string, style: ResolvedStyle): AsyncTaskSpec {
  const persons = shot.persons.length > 0 ? shot.persons.join('、') : '画面中的角色'
  return {
    model: keyframeModel({}),
    input: {
      prompt: `把这张综艺节目的实拍帧重绘为${style.label}（${style.prompt}）。
场景：${shot.sceneDesc || '承接上一镜头'}。出镜角色：${persons}。
要求：保持构图、机位、人物位置与动作与输入帧一致；保持每个角色的脸型、发型、服饰可辨识（人脸一致性强度 ${style.consistency}）；不要出现文字水印；不要改变画幅。`,
      images: [dataUrl(originalFrame)]
    },
    parameters: {
      n: 1,
      size: '1280*720',
      face_consistency: style.consistency,
      prompt_extend: false,
      water_mark: false
    }
  }
}

/** 图生视频动态化：关键帧作首帧，时长按分镜时长取整 */
function motionSpec(project: ProjectDto, shot: ShotDto, keyframe: string, style: ResolvedStyle): AsyncTaskSpec {
  const seconds = Math.max(2, Math.min(10, Math.round((shot.endMs - shot.startMs) / 1000)))
  const persons = shot.persons.length > 0 ? shot.persons.join('、') : '角色'
  return {
    model: motionModel({}),
    input: {
      prompt: `${style.prompt}。镜头内容：${shot.sceneDesc || '人物自然说话与轻微肢体动作'}。${persons} 保持原有站位与朝向，只做自然的说话、点头、手势与呼吸微动，不切换机位，不新增人物。`,
      img_url: dataUrl(keyframe)
    },
    parameters: {
      duration: seconds,
      fps: 30,
      resolution: '720P',
      prompt_extend: false,
      face_consistency: style.consistency
    }
  }
}

function dataUrl(file: string): string {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`
}

async function ensureOriginalFrame(project: ProjectDto, shot: ShotDto, dest: string): Promise<string> {
  if (existsSync(dest)) return dest
  const mid = Math.max(0, Math.round((shot.startMs + shot.endMs) / 2))
  const width = Math.max(640, Math.min(1280, project.width || 1280))
  await extractFrame(project.sourceVideoPath, Math.min(mid, Math.max(0, project.durationMs - 100)), dest, width)
  return dest
}

async function exportSize(project: ProjectDto): Promise<{ width: number; height: number; fps: number }> {
  const resolution = getSetting('export.resolution') === '720p' ? 720 : 1080
  const fps = getNum('export.fps') || 30
  const meta = project.width > 0 ? { width: project.width, height: project.height } : await probe(project.sourceVideoPath)
  const portrait = meta.height > meta.width
  const height = portrait ? resolution : Math.round((resolution * Math.max(meta.height, 1)) / Math.max(meta.width, 1))
  return {
    width: portrait ? Math.round((resolution * Math.max(meta.width, 1)) / Math.max(meta.height, 1)) : resolution,
    height: Math.max(2, height % 2 === 0 ? height : height + 1),
    fps
  }
}

function rowOf(shot: ShotDto, clip: string, status: string): RenderManifestRow {
  return {
    shot_id: shot.id,
    index: shot.index,
    keyframe: shot.frame3dPath,
    clip: clip || shot.clip3dPath,
    consistency: shot.consistencyScore,
    status,
    task_id: null,
    error: shot.error
  }
}

function trackTask(projectId: string, key: string, taskId: string | null, status: 'submitted' | 'running' | 'succeeded' | 'failed'): void {
  markDone(projectId, 5, 'cloud_task', key, '', { taskId: taskId ?? undefined, status })
}

/** 取该产物未完成的 taskId：有则复用查询而不是重新提交（不重复计费） */
function pendingTaskId(projectId: string, key: string): string | null {
  for (const a of Artifacts.list(projectId, 5)) {
    if (a.kind !== 'cloud_task') continue
    if (a.meta.key !== key) continue
    if (a.meta.status === 'succeeded') continue
    if (typeof a.taskId === 'string' && a.taskId) return a.taskId
    if (typeof a.meta.taskId === 'string' && a.meta.taskId) return a.meta.taskId
  }
  return null
}

export function renderConcurrencyLimit(): number {
  return isMock() ? 1 : Math.max(1, Math.min(2, getNum('render.concurrency') || 2))
}
