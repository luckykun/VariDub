/**
 * 步骤② 人声分离与中文识别（SPEC-001 §3.2）。
 * ① Demucs（本地 sidecar，串行 GPU 锁）分离人声/背景；
 * ② qwen-audio ASR 逐句转写 + 说话人分离；
 * ③ 为每位说话人自动截取 ≥20s 干净人声样本并做质量校验（<15s 或信噪比差标黄）。
 * 评审决议 R5：重叠语音按主说话人归类，丢弃第二人。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { JobRecord } from '../../jobs'
import { throwIfCancelled } from '../../jobs'
import type { LineDto, ProjectDto, ShotDto, SpeakerDto } from '../../../shared/types'
import { emit } from '../../events'
import { Lines, Shots, Speakers } from '../../db/repos'
import { getSetting, isMock } from '../../db/repos/settings'
import { cutAudioSegment, extractAudioWav, probe, runFFmpeg } from '../../media/ffmpeg'
import { asrSegments, wavDuration } from '../../bailian/audio'
import { checkVoiceSample } from '../analyzers'
import { projectPaths } from '../paths'
import { writeAsrCheckpoint } from '../checkpoints'
import { makeCtx } from './common'
import { sidecar } from '../../sidecar/client'
import { ensureStarted } from '../../sidecar/manager'
import { enqueueGpu } from '../gpuQueue'
import { newId } from '../../util/id'

export interface Step2Options {
  /** 换模型重跑 */
  model?: string | null
  /** 跳过 Demucs（已有 vocals.wav 时复用） */
  reuseSeparation?: boolean
}

interface Segment {
  startMs: number
  endMs: number
  speaker: string
  text: string
}

export async function runStep2(
  project: ProjectDto,
  job: JobRecord,
  opts: Step2Options = {}
): Promise<{ lines: LineDto[]; speakers: SpeakerDto[] }> {
  const paths = projectPaths(project.id)
  const ctx = makeCtx(project, job, paths)
  const shots = Shots.list(project.id)
  if (shots.length === 0) throw new Error('请先完成步骤①（分镜表为空）')

  ctx.progress(0.05, '抽取源视频音频轨')
  const rawAudio = join(paths.audioDir, 'source_audio.wav')
  if (!existsSync(rawAudio)) await extractAudioWav(project.sourceVideoPath, rawAudio)
  const durationMs = (await probe(rawAudio)).durationMs || project.durationMs

  ctx.progress(0.1, '人声 / 背景分离（Demucs 本地）')
  await separate(project, ctx, rawAudio, durationMs, opts.reuseSeparation !== true)
  throwIfCancelled(job)

  const vocalTrack = existsSync(paths.vocalsWav) ? paths.vocalsWav : rawAudio
  ctx.progress(0.35, '逐句中文转写 + 说话人分离（ASR）')
  const model = opts.model && opts.model !== 'auto' ? opts.model : getSetting('route.stage2.model')
  const segments = await asrInChunks(vocalTrack, model, ctx)
  if (segments.length === 0) throw new Error('ASR 没有识别到任何句子：请确认源视频含中文人声，或检查 API-KEY / 本地算力')
  ctx.log(`ASR 完成：${segments.length} 句`)

  ctx.progress(0.72, '登记说话人与音色样本')
  const { speakers, labelToId } = await registerSpeakers(project, ctx, segments, vocalTrack)
  ctx.progress(0.86, '写入逐句记录')
  const lines = buildLines(project, segments, speakers, labelToId, shots, durationMs)

  Lines.replaceAll(project.id, lines)
  writeAsrCheckpoint(project.id, {
    version: 1,
    projectId: project.id,
    model,
    audioUsed: vocalTrack,
    updatedAt: new Date().toISOString(),
    speakers: speakers.map((s) => ({ id: s.id, label: s.label, sample: s.sampleWavPath, quality: s.sampleQuality })),
    segments: segments.map((s) => ({
      start_ms: s.startMs,
      end_ms: s.endMs,
      speaker_label: s.speaker,
      zh: s.text,
      line_id: lines.find((l) => l.startMs === s.startMs)?.id ?? null
    }))
  })
  ctx.progress(1, `转写 ${lines.length} 句，说话人 ${speakers.length} 位`)
  emit({ type: 'lines:update', projectId: project.id })
  emit({ type: 'speakers:update', projectId: project.id })
  emit({ type: 'project:update', projectId: project.id })
  return { lines, speakers }
}

/** 分离：走本地 sidecar（GPU 串行锁）；sidecar 不可用时明确失败并给日志路径 */
async function separate(
  project: ProjectDto,
  ctx: ReturnType<typeof makeCtx>,
  rawAudio: string,
  durationMs: number,
  force: boolean
): Promise<void> {
  const paths = ctx.paths
  if (!force && existsSync(paths.vocalsWav) && existsSync(paths.bgmWav)) {
    ctx.log('复用已存在的 vocals.wav / bgm.wav')
    return
  }
  if (isMock()) {
    // 冒烟/离线模式：人声轨=源音频，背景轨=静音，保证链路可跑（§7.8）
    ctx.log('Mock 模式：跳过 Demucs，人声轨直接使用源音频，背景轨为静音')
    await fakeSeparation(rawAudio, paths.vocalsWav, paths.bgmWav, durationMs, ctx)
    return
  }
  try {
    await ensureStarted()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`本地算力（sidecar）不可用：${msg}｜日志：${paths.logsDir}`)
  }
  ctx.progress(0.15, 'Demucs 排队中（本机 GPU 同一时刻仅 1 个任务）')
  const outDir = join(paths.audioDir, 'demucs')
  const result = await enqueueGpu('separate', `Demucs 分离 ${project.name}`, project.id, () =>
    sidecar.separate(rawAudio, outDir, { twoStem: true, onLine: (line) => ctx.log(line) })
  )
  // sidecar 返回 <out_dir>/<model>/<track>.wav；统一转 44.1k 立体声落检查点
  await toWav(result.vocals, paths.vocalsWav)
  if (result.bgm) await toWav(result.bgm, paths.bgmWav)
  else await silentWav(paths.bgmWav, durationMs)
  ctx.progress(0.33, '双音轨就绪（可试听）')
}

async function toWav(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) throw new Error(`分离产物缺失：${src}`)
  await runFFmpeg(['-y', '-i', src, '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', dest], { timeoutMs: 120_000 })
}

async function silentWav(dest: string, durationMs: number): Promise<void> {
  await runFFmpeg(
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-t', (durationMs / 1000).toFixed(3), '-acodec', 'pcm_s16le', dest],
    { timeoutMs: 60_000 }
  )
}

async function fakeSeparation(rawAudio: string, vocals: string, bgm: string, durationMs: number, ctx: ReturnType<typeof makeCtx>): Promise<void> {
  await runFFmpeg(['-y', '-i', rawAudio, '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', vocals], { timeoutMs: 120_000 })
  await silentWav(bgm, durationMs)
  ctx.log('（近似）人声轨=源音频，背景轨=静音')
}

/**
 * ASR 分段提交：长音频按 90s 切片逐段转写（16kHz 单声道降低上行体积），
 * 时间码加偏移；跨段的说话人标签按「首次出现顺序」归一为 S1/S2…。
 */
async function asrInChunks(audio: string, model: string, ctx: ReturnType<typeof makeCtx>): Promise<Segment[]> {
  const durationMs = (await probe(audio)).durationMs
  const chunkMs = 90_000
  const all: Segment[] = []
  const seen = new Set<string>()
  const labelMap = new Map<string, string>()
  let chunkIndex = 0
  for (let start = 0; start < durationMs; start += chunkMs) {
    throwIfCancelled(ctx.job)
    const end = Math.min(durationMs, start + chunkMs)
    const file = join(ctx.paths.audioDir, `asr_chunk_${String(chunkIndex).padStart(2, '0')}.wav`)
    if (!existsSync(file)) await cutAudioSegment(audio, start, end, file, 16_000)
    const res = await asrSegments(file, model, start)
    for (const seg of res.segments) {
      if (!seg.text.trim()) continue
      const globalLabel = labelMap.get(seg.speaker) ?? globalizeLabel(seen, seg.speaker)
      labelMap.set(seg.speaker, globalLabel)
      seen.add(globalLabel)
      all.push({
        startMs: seg.startMs,
        endMs: Math.max(seg.startMs + 300, seg.endMs),
        speaker: globalLabel,
        text: seg.text
      })
    }
    ctx.progress(0.35 + 0.35 * (end / Math.max(durationMs, 1)), `ASR 分段 ${chunkIndex + 1}（${Math.round(end / 1000)}s / ${Math.round(durationMs / 1000)}s）`)
    chunkIndex += 1
  }
  return all.sort((a, b) => a.startMs - b.startMs)
}

function globalizeLabel(seen: Set<string>, raw: string): string {
  void raw
  let n = seen.size + 1
  let label = `S${n}`
  while (seen.has(label)) {
    n += 1
    label = `S${n}`
  }
  return label
}

/** 每位说话人：取累计时长最大的语音区间作为音色样本（目标 ≥20s，避开重叠），并做质量校验 */
async function registerSpeakers(
  project: ProjectDto,
  ctx: ReturnType<typeof makeCtx>,
  segments: Segment[],
  vocalTrack: string
): Promise<{ speakers: SpeakerDto[]; labelToId: Map<string, string> }> {
  const bySpeaker = new Map<string, Array<{ startMs: number; endMs: number }>>()
  for (const seg of segments) {
    const list = bySpeaker.get(seg.speaker) ?? []
    list.push({ startMs: seg.startMs, endMs: seg.endMs })
    bySpeaker.set(seg.speaker, list)
  }
  // 保留既有的音色映射（重跑②不打断已确认的克隆音色）
  const previous = Speakers.list(project.id)
  const mappedByLabel = new Map(previous.map((s) => [s.label, s.mappedVoiceId]))
  Speakers.replaceAll(project.id, [])

  const speakers: SpeakerDto[] = []
  const labelToId = new Map<string, string>()
  const labels = [...bySpeaker.keys()].sort(compareLabels)
  for (const label of labels) {
    const ranges = bySpeaker.get(label) ?? []
    const sample = pickSampleRange(ranges, 20_000)
    const file = ctx.paths.sampleOf(label)
    let quality: SpeakerDto['sampleQuality'] = 'short'
    let note = '没有足够的干净人声区间'
    let dur = 0
    if (sample) {
      await cutAudioSegment(vocalTrack, sample.startMs, sample.endMs, file)
      dur = await wavDuration(file)
      const q = await checkVoiceSample(file, dur)
      quality = q.level
      note = q.note
    }
    const created = Speakers.create(project.id, label)
    Speakers.patch(created.id, {
      sampleWavPath: sample ? file : null,
      sampleStartMs: sample?.startMs ?? null,
      sampleEndMs: sample?.endMs ?? null,
      sampleQuality: quality,
      sampleQualityNote: note,
      mappedVoiceId: mappedByLabel.get(label) ?? null
    })
    speakers.push({
      ...created,
      sampleWavPath: sample ? file : null,
      sampleStartMs: sample?.startMs ?? null,
      sampleEndMs: sample?.endMs ?? null,
      sampleQuality: quality,
      sampleQualityNote: note,
      mappedVoiceId: mappedByLabel.get(label) ?? null
    })
    labelToId.set(label, created.id)
    ctx.log(`说话人 ${label}：样本 ${(dur / 1000).toFixed(1)}s · ${quality} · ${note}`)
  }
  return { speakers, labelToId }
}

function compareLabels(a: string, b: string): number {
  const na = Number(/(\d+)/.exec(a)?.[1] ?? 0)
  const nb = Number(/(\d+)/.exec(b)?.[1] ?? 0)
  return na === nb ? a.localeCompare(b) : na - nb
}

function pickSampleRange(ranges: Array<{ startMs: number; endMs: number }>, targetMs: number): { startMs: number; endMs: number } | null {
  const sorted = [...ranges].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
  const best = sorted[0]
  if (!best) return null
  const total = sorted.reduce((acc, r) => acc + (r.endMs - r.startMs), 0)
  if (total >= targetMs) {
    const duration = best.endMs - best.startMs
    if (duration >= targetMs) return { startMs: best.startMs, endMs: best.startMs + targetMs }
    const next = sorted[1]
    if (next) return { startMs: Math.min(best.startMs, next.startMs), endMs: Math.max(best.endMs, next.endMs) }
    return best
  }
  return best
}

/** 逐句记录：句级时间锚点在此确立，之后全链路引用（SPEC-001 §7.7-2） */
function buildLines(
  project: ProjectDto,
  segments: Segment[],
  speakers: SpeakerDto[],
  labelToId: Map<string, string>,
  shots: ShotDto[],
  durationMs: number
): LineDto[] {
  return segments.map((seg, i): LineDto => {
    const shot = shots.find((s) => seg.startMs >= s.startMs && seg.startMs < s.endMs) ?? shots[shots.length - 1]
    const startMs = Math.max(0, Math.min(durationMs, seg.startMs))
    const endMs = Math.max(startMs + 300, Math.min(durationMs, seg.endMs))
    return {
      id: newId('lin'),
      projectId: project.id,
      shotId: shot?.id ?? null,
      speakerId: labelToId.get(seg.speaker) ?? speakers[0]?.id ?? null,
      index: i,
      startMs,
      endMs,
      zhText: seg.text,
      enText: '',
      enAlts: [],
      slangFlag: false,
      slangNote: null,
      overflowMs: 0,
      overflowPolicy: 'none',
      confirmStatus: 'pending',
      dubWavPath: null,
      dubDurationMs: null,
      similarity: null,
      lipsyncStatus: 'none',
      lipsyncOffsetMs: null,
      anchorStale: false
    }
  })
}
