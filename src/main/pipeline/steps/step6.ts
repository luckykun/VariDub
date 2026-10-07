/**
 * 步骤⑥ 口型对齐 + 合成导出（SPEC-001 §3.6）。
 * ① MuseTalk 逐分镜驱动 3D 人物口型对齐英文音轨（本地 GPU，串行锁）；
 * ② ffmpeg 按句级时间锚点铺音轨 → 与背景轨原音量混音（评审决议 R4，无 ducking 无开关）；
 * ③ 画面 + 混音合成成片 MP4；④ 双语 SRT 外挂（评审决议 R7，不烧录）；⑤ 偏差报告 + 导出到导出目录。
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { JobRecord } from '../../jobs'
import { throwIfCancelled } from '../../jobs'
import type { LineDto, ProjectDto, ShotDto } from '../../../shared/types'
import type { DeviationRowDto, FinalProductDto } from '../../../shared/api'
import { emit } from '../../events'
import { Artifacts, Lines, Shots } from '../../db/repos'
import { getBool, getNum, getSetting } from '../../db/repos/settings'
import { ensureParent, log } from '../../logger'
import { enqueueGpu } from '../gpuQueue'
import { sidecar } from '../../sidecar/client'
import { mockMode } from '../../bailian/chat'
import { buildTimelineTrack, compose, mixTracks, probe, timelineFromSegments } from '../../media/ffmpeg'
import { writeSrt } from '../../media/subtitle'
import { writeJson } from '../../util/json'
import { projectPaths } from '../paths'
import { markDone } from '../checkpoints'
import { makeCtx } from './common'

export interface Step6Options {
  /** 跳过 MuseTalk（无可用 GPU / sidecar 掉线时仍要出片） */
  skipLipsync?: boolean
  /** 导出文件名（不含扩展名），默认取项目名 */
  name?: string | null
  resolution?: '1080p' | '720p'
  fps?: number
  bilingual?: boolean
}

export type FinalProduct = FinalProductDto

export type DeviationRow = DeviationRowDto

export async function runStep6(project: ProjectDto, job: JobRecord, opts: Step6Options = {}): Promise<FinalProduct> {
  const paths = projectPaths(project.id)
  ensureParent(paths.finalDir)
  const ctx = makeCtx(project, job, paths)

  const shots = Shots.list(project.id)
  const lines = Lines.list(project.id)
  const fps = opts.fps ?? (getNum('export.fps') || 30)
  const size = await exportSize(project, opts.resolution)
  const usable = shots.filter((s) => s.clip3dPath && existsSync(s.clip3dPath))
  if (usable.length === 0) throw new Error('没有可用的 3D 分镜片段：请先完成步骤⑤并「接受」分镜')
  const dubbed = lines.filter((l) => l.dubWavPath && existsSync(l.dubWavPath))
  if (dubbed.length === 0) throw new Error('没有可用的配音句子：请先完成步骤④')

  /* ① 口型对齐（逐分镜，GPU 串行） */
  let lipsyncDone = 0
  let lipsyncSkipped = 0
  const lipsyncUsable = opts.skipLipsync !== true && !mockMode()
  if (!lipsyncUsable) {
    ctx.log(opts.skipLipsync ? '已按要求跳过 MuseTalk 口型对齐（画面用 3D 片段原样拼接）' : 'Mock 模式：跳过本地口型任务')
    lipsyncSkipped = dubbed.length
  } else {
    ctx.progress(0.03, '检查本地算力（sidecar）')
    try {
      await sidecar.health()
    } catch {
      try {
        const { ensureStarted } = await import('../../sidecar/manager')
        await ensureStarted()
      } catch (err) {
        ctx.log(`sidecar 启动失败：${err instanceof Error ? err.message : String(err)}；本片跳过口型对齐`)
      }
    }
    if (!sidecar.status.online || !sidecar.status.models.musetalk) {
      ctx.log(`MuseTalk 不可用（${sidecar.status.reason ?? sidecar.status.mismatch ?? '模型未就绪'}）：跳过口型，成片仍可用`)
      lipsyncSkipped = dubbed.length
    } else {
      const targets = shots.filter((s) => s.clip3dPath && existsSync(s.clip3dPath) && overlapping(dubbed, s).length > 0)
      ctx.log(`口型对齐：${targets.length} 个分镜含配音，逐句驱动 MuseTalk（GPU 串行）`)
      for (let i = 0; i < targets.length; i += 1) {
        throwIfCancelled(job)
        const shot = targets[i]
        const clip = shot.clip3dPath!
        const shotLines = overlapping(dubbed, shot)
        const segWav = join(paths.audioDir, `${shot.id}.dubseg.wav`)
        const lipClip = lipPathOf(paths.shots3dDir, shot.id)
        try {
          await buildTimelineTrack(
            shotLines.map((l) => ({ startMs: Math.max(0, l.startMs - shot.startMs), file: l.dubWavPath! })),
            shot.endMs - shot.startMs,
            segWav
          )
          const result = await enqueueGpu('lipsync', `MuseTalk 分镜#${shot.index + 1}`, project.id, () =>
            sidecar.lipsync({
              video: clip,
              audio: segWav,
              out: lipClip,
              fps,
              onLine: (line) => ctx.log(`分镜#${shot.index + 1} ${line}`)
            })
          )
          const out = result.video && existsSync(result.video) ? result.video : lipClip
          if (!existsSync(out)) throw new Error('MuseTalk 未产出口型视频')
          // 口型产物按约定路径落盘（clipFor 优先取用它），无需新增列
          markDone(project.id, 6, 'shot3d_clip', `${shot.id}:lip`, out, { musetalk: true })
          lipsyncDone += shotLines.length
          Lines.setMany(
            shotLines.map((l) => l.id),
            { lipsyncStatus: 'done', lipsyncOffsetMs: result.offset_ms ?? 0, anchorStale: false }
          )
          ctx.log(`分镜#${shot.index + 1} 口型完成（偏移 ${result.offset_ms ?? 0}ms）`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn('step6', `分镜#${shot.index + 1} 口型失败：${msg}`)
          ctx.log(`分镜#${shot.index + 1} 口型失败：${msg}（该段用原始 3D 片段）`)
          lipsyncSkipped += shotLines.length
          Lines.setMany(
            shotLines.map((l) => l.id),
            { lipsyncStatus: 'failed' }
          )
        }
        ctx.progress(0.05 + (0.5 * (i + 1)) / targets.length, `口型 ${i + 1}/${targets.length}`)
      }
    }
  }

  /* ② 画面时间轴（口型片段优先，回退 3D 片段；按分镜窗口精确对齐时长） */
  throwIfCancelled(job)
  ctx.progress(0.6, '拼接 3D 画面时间轴')
  const baseVideo = join(paths.finalDir, 'video_base.mp4')
  await timelineFromSegments(
    usable.map((s) => ({ file: clipFor(s, paths.shots3dDir), targetMs: s.endMs - s.startMs })),
    baseVideo,
    size
  )

  /* ③ 配音按句级锚点铺轨 + 背景轨原音量混入 */
  ctx.progress(0.7, '铺英文配音轨（句级锚点）')
  const dubTrack = join(paths.finalDir, 'dub_track.wav')
  await buildTimelineTrack(dubbed.map((l) => ({ startMs: l.startMs, file: l.dubWavPath! })), project.durationMs, dubTrack)
  const totalMs = (await probe(baseVideo)).durationMs || project.durationMs
  ctx.progress(0.78, '混入背景音（原音量，不做 ducking）')
  const bgm = paths.bgmWav && existsSync(paths.bgmWav) ? paths.bgmWav : ''
  const mixed = join(paths.finalDir, 'audio_mixed.wav')
  await mixTracks(bgm ? [dubTrack, bgm] : [dubTrack], mixed)
  if (!bgm) ctx.log('未找到背景轨（bgm.wav）：成片只有英文配音')

  /* ④ 合成成片 */
  const name = safeName(opts.name ?? project.name)
  const mp4 = paths.finalMp4(name)
  ctx.progress(0.84, '合成成片 MP4')
  await compose({ video: baseVideo, audio: mixed, outMp4: mp4, fps: size.fps, job })

  /* ⑤ 双语 SRT（外挂） */
  const bilingual = opts.bilingual ?? getBool('export.bilingual_srt')
  const srt = paths.finalSrt(name)
  writeSrt(srt, lines.filter((l) => l.enText.trim() || l.zhText.trim()), bilingual)
  markDone(project.id, 6, 'final_srt', `${name}.srt`, srt, { bilingual })

  /* ⑥ 偏差报告（审片器 + 交付说明） */
  const report = join(paths.finalDir, `${name}.report.json`)
  const rows = deviationReport(lines)
  writeJson(report, {
    version: 1,
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    video: mp4,
    srt,
    size,
    duration_ms: totalMs,
    summary: {
      lines: lines.length,
      dubbed: dubbed.length,
      lipsync_done: lipsyncDone,
      lipsync_skipped: lipsyncSkipped,
      red: rows.filter((r) => r.flag === 'red').length,
      yellow: rows.filter((r) => r.flag === 'yellow').length
    },
    shots: usable.map((s) => ({ index: s.index, start_ms: s.startMs, end_ms: s.endMs, clip: clipFor(s, paths.shots3dDir) })),
    lines: rows
  })
  markDone(project.id, 6, 'final_mp4', `${name}.mp4`, mp4, {
    // 元信息一并入库：审片器与「导出」重试都从这条记录还原成片状态（否则刷新后全是 0）
    srt,
    report,
    durationMs: totalMs,
    width: size.width,
    height: size.height,
    fps: size.fps,
    lipsyncDone,
    lipsyncSkipped
  })

  /* ⑦ 导出到设置页指定目录（默认桌面） */
  let exportedTo: string | null = null
  const exportDir = exportDirOf()
  if (exportDir) {
    try {
      exportedTo = exportFinal(project, exportDir, name)
      ctx.log(`已导出到 ${exportedTo}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('step6', `导出失败：${msg}`)
      ctx.log(`导出失败：${msg}（成片仍在 ${paths.finalDir}，可在底部重试）`)
    }
  }

  ctx.progress(1, `成片完成：${mp4}`)
  emit({ type: 'lines:update', projectId: project.id })
  emit({ type: 'project:update', projectId: project.id })
  return {
    name,
    mp4,
    srt,
    report,
    durationMs: totalMs,
    width: size.width,
    height: size.height,
    fps: size.fps,
    lipsyncDone,
    lipsyncSkipped,
    exportedTo
  }
}

/** 只重做导出（审片器底部「导出到文件夹」） */
export function exportFinal(project: ProjectDto, destDir: string, name?: string | null): string {
  const paths = projectPaths(project.id)
  const finalName = safeName(name ?? latestName(project.id) ?? project.name)
  const mp4 = existsSync(paths.finalMp4(finalName)) ? paths.finalMp4(finalName) : latestArtifact(project.id, 'final_mp4')
  const srt = existsSync(paths.finalSrt(finalName)) ? paths.finalSrt(finalName) : latestArtifact(project.id, 'final_srt')
  if (!mp4) throw new Error('还没有成片，请先跑一次步骤⑥')
  ensureParent(destDir)
  const destMp4 = join(destDir, mp4Name(mp4, finalName))
  copyFileSync(mp4, destMp4)
  if (srt && existsSync(srt)) copyFileSync(srt, join(destDir, srtName(srt, finalName)))
  const report = join(paths.finalDir, `${finalName}.report.json`)
  if (existsSync(report)) copyFileSync(report, join(destDir, `${finalName}.report.json`))
  // 回写导出位置：否则刷新/重进项目后「已导出」状态丢失，UI 会一直显示未导出
  Artifacts.upsert({ projectId: project.id, step: 6, kind: 'final_mp4', path: mp4, meta: { exportedTo: destMp4 }, match: (a) => a.path === mp4 })
  return destMp4
}

/** 审片器数据：偏差报告（绿/黄/红 + 口型偏移） */
export function deviationReport(lines: LineDto[]): DeviationRow[] {
  return [...lines]
    .sort((a, b) => a.index - b.index)
    .map((l) => {
      const deviation = l.dubDurationMs === null ? null : Math.round(l.dubDurationMs - (l.endMs - l.startMs))
      const compressed = l.overflowPolicy === 'compress' && l.overflowMs > 0
      const flag: DeviationRow['flag'] =
        l.lipsyncStatus === 'failed' || (!l.dubWavPath && l.enText.trim()) ? 'red' : compressed || (deviation !== null && deviation > 300) ? 'yellow' : 'green'
      return {
        index: l.index,
        line_id: l.id,
        speaker: l.speakerId,
        target_ms: l.endMs - l.startMs,
        dub_ms: l.dubDurationMs,
        deviation_ms: deviation,
        flag,
        lipsync: l.lipsyncStatus,
        lipsync_offset_ms: l.lipsyncOffsetMs,
        note: l.dubWavPath ? null : l.enText.trim() ? '缺配音' : '空句'
      }
    })
}

/** 当前成片（无则 null，UI 显示「尚未导出」） */
export function currentProduct(projectId: string): FinalProduct | null {
  const rows = Artifacts.list(projectId, 6).filter((a) => a.kind === 'final_mp4' && a.path && existsSync(a.path))
  const row = rows[rows.length - 1]
  if (!row) return null
  const mp4 = row.path
  const name = latestName(projectId) ?? 'final'
  const paths = projectPaths(projectId)
  const meta = row.meta
  const num = (key: string): number => (typeof meta[key] === 'number' ? (meta[key] as number) : 0)
  const str = (key: string): string | null => (typeof meta[key] === 'string' && (meta[key] as string) ? (meta[key] as string) : null)
  return {
    name,
    mp4,
    srt: str('srt') ?? latestArtifact(projectId, 'final_srt') ?? paths.finalSrt(name),
    report: str('report') ?? join(paths.finalDir, `${name}.report.json`),
    durationMs: num('durationMs'),
    width: num('width'),
    height: num('height'),
    fps: num('fps'),
    lipsyncDone: num('lipsyncDone'),
    lipsyncSkipped: num('lipsyncSkipped'),
    exportedTo: str('exportedTo')
  }
}

export function exportDirOf(): string {
  return getSetting('storage.export_dir').trim() || defaultExportDir()
}

function defaultExportDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (!home) return ''
  const desk = join(home, 'Desktop')
  return existsSync(desk) ? desk : home
}

/* ------------------------------------------------------------------ 内部 */

function lipPathOf(shots3dDir: string, shotId: string): string {
  return join(shots3dDir, `${shotId}.lip.mp4`)
}

/** 口型产物存在就用它，否则回退 3D 片段（保证流程不中断） */
function clipFor(shot: ShotDto, shots3dDir: string): string {
  const lip = lipPathOf(shots3dDir, shot.id)
  return existsSync(lip) ? lip : shot.clip3dPath!
}

function overlapping(lines: LineDto[], shot: ShotDto): LineDto[] {
  return lines.filter((l) => l.dubWavPath && l.endMs > shot.startMs && l.startMs < shot.endMs)
}

async function exportSize(project: ProjectDto, resolution?: '1080p' | '720p'): Promise<{ width: number; height: number; fps: number }> {
  const res = (resolution ?? getSetting('export.resolution')) === '720p' ? 720 : 1080
  const fps = getNum('export.fps') || 30
  const meta = project.width > 0 ? { width: project.width, height: project.height } : await probe(project.sourceVideoPath)
  const portrait = meta.height > meta.width
  const even = (n: number): number => (n % 2 === 0 ? n : n + 1)
  const width = portrait ? even(Math.round((res * Math.max(meta.width, 1)) / Math.max(meta.height, 1))) : res
  const height = portrait ? res : even(Math.round((res * Math.max(meta.height, 1)) / Math.max(meta.width, 1)))
  return { width, height, fps }
}

function latestArtifact(projectId: string, kind: 'final_mp4' | 'final_srt'): string | null {
  const rows = Artifacts.list(projectId, 6).filter((a) => a.kind === kind && a.path && existsSync(a.path))
  return rows.length > 0 ? rows[rows.length - 1]!.path : null
}

function latestName(projectId: string): string | null {
  const rows = Artifacts.list(projectId, 6).filter((a) => a.kind === 'final_mp4')
  const last = rows[rows.length - 1]
  if (!last) return null
  const base = last.path.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.mp4$/i, '') || null
}

function mp4Name(file: string, name: string): string {
  return `${name}${extOf(file, '.mp4')}`
}

function srtName(file: string, name: string): string {
  return `${name}${extOf(file, '.srt')}`
}

function extOf(file: string, fallback: string): string {
  const m = /\.[A-Za-z0-9]+$/.exec(file)
  return m ? m[0] : fallback
}

function safeName(text: string): string {
  const clean = text
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean || 'final').slice(0, 80)
}
