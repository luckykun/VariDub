/**
 * 步骤④ 音色克隆英文配音（SPEC-001 §3.4）。
 * 每位说话人：音色样本 → 云端复刻音色（一次注册，全句复用）→ 朗读已确认英文 → 逐句 WAV。
 * 相似度 <80% 标红；超支句按策略压缩语速（黄标）或允许停顿（freeze）。
 */
import { existsSync, readFileSync } from 'node:fs'
import type { JobRecord } from '../../jobs'
import { throwIfCancelled } from '../../jobs'
import type { LineDto, ProjectDto, SpeakerDto, VoiceDto } from '../../../shared/types'
import { emit } from '../../events'
import { Lines, Speakers, Voices } from '../../db/repos'
import { getNum, getSetting } from '../../db/repos/settings'
import { PRESET_VOICES } from '../../../shared/models'
import { enrollVoice, estimateSimilarity, synthesize, wavDuration } from '../../bailian/audio'
import { estimateSpeechMs } from '../analyzers'
import { projectPaths } from '../paths'
import { writeDubCheckpoint, type DubManifestRow } from '../checkpoints'
import { makeCtx } from './common'
import { log } from '../../logger'

export interface Step4Options {
  model?: string | null
  /** 重配全部句子（默认跳过已有配音且未过期的句子） */
  force?: boolean
  /** 连未确认的句子一起配（默认只配 confirmed） */
  includeUnconfirmed?: boolean
}

/** 相似度红线（<80% 阻断确认，SPEC-001 §3.4） */
export const SIMILARITY_BLOCK = 80

export async function runStep4(project: ProjectDto, job: JobRecord, opts: Step4Options = {}): Promise<LineDto[]> {
  const paths = projectPaths(project.id)
  const ctx = makeCtx(project, job, paths)
  const model = opts.model && opts.model !== 'auto' ? opts.model : getSetting('route.stage4.model')
  const all = Lines.list(project.id)
  const targets = all.filter((l) => {
    if (!l.enText.trim()) return false
    if (!opts.includeUnconfirmed && l.confirmStatus !== 'confirmed') return false
    if (!opts.force && l.dubWavPath && !l.anchorStale && existsSync(l.dubWavPath)) return false
    return true
  })
  if (targets.length === 0) {
    const usable = all.filter((l) => l.confirmStatus === 'confirmed' && l.enText.trim()).length
    throw new Error(`没有需要配音的句子（已确认 ${usable} / ${all.length} 句）。请先到步骤③确认译文，或勾选「重配全部」`)
  }

  ctx.progress(0.04, `准备 ${Speakers.list(project.id).length} 位说话人的音色`)
  const voiceBySpeaker = new Map<string, ResolvedVoice>()
  for (const speaker of Speakers.list(project.id)) {
    const resolved = await resolveVoice(project, speaker, model, ctx)
    if (resolved) voiceBySpeaker.set(speaker.id, resolved)
  }
  if (voiceBySpeaker.size === 0) throw new Error('没有可用的说话人音色：请回到步骤②确认音色样本')

  const speed = getNum('dub.speed') || 1
  const pitch = getNum('dub.pitch')
  const emotion = getNum('dub.emotion') || 0.5
  const rows: DubManifestRow[] = []
  let done = 0
  let redFlags = 0

  for (const line of targets) {
    throwIfCancelled(job)
    const voice = line.speakerId ? voiceBySpeaker.get(line.speakerId) : undefined
    if (!voice) {
      ctx.log(`跳过第 ${line.index + 1} 句：说话人未登记音色`)
      continue
    }
    const windowMs = line.endMs - line.startMs
    // 超支策略：compress = 提高语速；freeze/none = 原速（允许占用后续停顿）
    const est = estimateSpeechMs(line.enText, speed)
    const effectiveSpeed = line.overflowPolicy === 'compress' && est > windowMs ? Math.min(1.6, speed * (est / Math.max(windowMs, 300))) : speed
    const out = paths.dubOf(line.id)
    try {
      const result = await synthesize({
        index: line.index,
        text: line.enText,
        voiceId: voice.vendorVoiceId,
        presetName: voice.presetName,
        referenceWav: voice.samplePath,
        model,
        speed: Math.round(effectiveSpeed * 100) / 100,
        pitch,
        emotion,
        outWav: out
      })
      const actualMs = result.durationMs || (await wavDuration(out))
      const deviation = Math.round(actualMs - windowMs)
      const refWav = voice.samplePath
      const sim = refWav && existsSync(refWav) ? await estimateSimilarity(refWav, out) : { score: 0, method: 'estimated' as const, detail: '无音色样本可比对' }
      Lines.patch(line.id, {
        dubWavPath: out,
        dubDurationMs: actualMs,
        similarity: sim.score,
        lipsyncStatus: 'none',
        anchorStale: false,
        // 实际时长写回，UI 用它显示真实偏差
        overflowMs: Math.max(0, deviation)
      })
      if (sim.score < SIMILARITY_BLOCK) redFlags += 1
      rows.push({
        line_id: line.id,
        index: line.index,
        speaker: voice.label,
        wav: out,
        target_ms: windowMs,
        actual_ms: actualMs,
        deviation_ms: deviation,
        similarity: sim.score,
        similarity_method: `${sim.method}：${sim.detail}`,
        voice_source: voice.sourceType === 'preset' ? `预置 ${voice.name}` : `克隆 ${voice.name}`,
        status: 'ok'
      })
      ctx.log(`第 ${line.index + 1} 句配音完成：目标 ${windowMs}ms / 实际 ${actualMs}ms · 相似度 ${sim.score}%（${sim.method}）`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('step4', `第 ${line.index + 1} 句配音失败：${msg}`)
      rows.push({
        line_id: line.id,
        index: line.index,
        speaker: voice.label,
        wav: null,
        target_ms: windowMs,
        actual_ms: null,
        deviation_ms: null,
        similarity: null,
        similarity_method: null,
        voice_source: voice.name,
        status: `failed：${msg.slice(0, 120)}`
      })
      Lines.patch(line.id, { dubWavPath: null, similarity: null })
    }
    done += 1
    ctx.progress(0.08 + (0.92 * done) / targets.length, `配音 ${done}/${targets.length}`)
  }

  const lines = Lines.list(project.id)
  const merged = mergeManifest(project.id, rows)
  writeDubCheckpoint(project.id, merged)
  const failed = merged.filter((r) => r.status.startsWith('failed')).length
  ctx.progress(1, `配音完成：${done} 句（红标 ${redFlags}，失败 ${failed}）`)
  emit({ type: 'lines:update', projectId: project.id })
  emit({ type: 'voices:update' })
  emit({ type: 'project:update', projectId: project.id })
  if (failed > 0 && failed === done) throw new Error(`全部句子配音失败：${merged.find((r) => r.status.startsWith('failed'))?.status ?? ''}（设置页可检查 API-KEY 与模型）`)
  return lines
}

/** 单句重配（「重配此句」按钮） */
export async function dubOneLine(project: ProjectDto, lineId: string, model?: string | null): Promise<LineDto | null> {
  const paths = projectPaths(project.id)
  const line = Lines.get(lineId)
  if (!line || line.projectId !== project.id) return null
  if (!line.enText.trim()) throw new Error('该句还没有确认的英文译文')
  const speaker = line.speakerId ? Speakers.get(line.speakerId) : null
  if (!speaker) throw new Error('该句没有关联说话人，无法取音色')
  const ttsModel = model && model !== 'auto' ? model : getSetting('route.stage4.model')
  const ctx = { log: (m: string) => log.info('step4', m) }
  const voice = await resolveVoice(project, speaker, ttsModel, ctx)
  if (!voice) throw new Error(`说话人 ${speaker.label} 的音色不可用`)
  const windowMs = line.endMs - line.startMs
  const speed = getNum('dub.speed') || 1
  const est = estimateSpeechMs(line.enText, speed)
  const effectiveSpeed = line.overflowPolicy === 'compress' && est > windowMs ? Math.min(1.6, speed * (est / Math.max(windowMs, 300))) : speed
  const out = paths.dubOf(line.id)
  const result = await synthesize({
    index: line.index,
    text: line.enText,
    voiceId: voice.vendorVoiceId,
    presetName: voice.presetName,
    referenceWav: voice.samplePath,
    model: ttsModel,
    speed: Math.round(effectiveSpeed * 100) / 100,
    pitch: getNum('dub.pitch'),
    emotion: getNum('dub.emotion') || 0.5,
    outWav: out
  })
  const actualMs = result.durationMs || (await wavDuration(out))
  const sim = voice.samplePath && existsSync(voice.samplePath) ? await estimateSimilarity(voice.samplePath, out) : { score: 0, method: 'estimated' as const, detail: '无样本' }
  Lines.patch(line.id, {
    dubWavPath: out,
    dubDurationMs: actualMs,
    similarity: sim.score,
    overflowMs: Math.max(0, Math.round(actualMs - windowMs)),
    lipsyncStatus: 'none',
    anchorStale: false
  })
  emit({ type: 'lines:update', projectId: project.id })
  return Lines.get(line.id)
}

interface ResolvedVoice {
  voiceId: string
  name: string
  label: string
  sourceType: VoiceDto['sourceType']
  vendorVoiceId: string | null
  presetName: string | null
  samplePath: string | null
}

/** 音色来源三选一（§3.4）：已映射的克隆音色 / 音色库现成音色 / 本步骤现场克隆 */
async function resolveVoice(
  project: ProjectDto,
  speaker: SpeakerDto,
  ttsModel: string,
  ctx: { log: (m: string) => void }
): Promise<ResolvedVoice | null> {
  const paths = projectPaths(project.id)
  const sample = speaker.sampleWavPath && existsSync(speaker.sampleWavPath) ? speaker.sampleWavPath : null
  const mapped = speaker.mappedVoiceId ? Voices.get(speaker.mappedVoiceId) : null
  if (mapped) {
    // 手动指定预置音色：不需要云端注册，直接用名字
    if (mapped.sourceType === 'preset') {
      return { voiceId: mapped.id, name: mapped.name, label: speaker.label, sourceType: 'preset', vendorVoiceId: null, presetName: mapped.name, samplePath: mapped.samplePath }
    }
    if (mapped.vendorVoiceId) {
      return { voiceId: mapped.id, name: mapped.name, label: speaker.label, sourceType: 'cloned', vendorVoiceId: mapped.vendorVoiceId, presetName: null, samplePath: mapped.samplePath ?? sample }
    }
  }

  if (!sample) {
    ctx.log(`说话人 ${speaker.label} 没有音色样本，回退预置音色` + (PRESET_VOICES[0] ? `（${PRESET_VOICES[0].name}）` : ''))
    const fallback = PRESET_VOICES[0]
    if (!fallback) return null
    return { voiceId: '', name: fallback.name, label: speaker.label, sourceType: 'preset', vendorVoiceId: null, presetName: fallback.name, samplePath: null }
  }

  const prefix = `${project.id.slice(-6)}_spk${speaker.id.slice(-4)}`.replace(/[^a-zA-Z0-9_]/g, '')
  const enroll = await enrollVoice(sample, ttsModel, prefix)
  const durationMs = await wavDuration(sample)
  const created = Voices.create({
    name: `${project.name} · ${speaker.label}`,
    sourceType: 'cloned',
    originProjectId: project.id,
    tags: [enroll.enrolled ? '云端复刻' : '样本驱动', speaker.label],
    samplePath: sample,
    durationMs,
    vendorVoiceId: enroll.enrolled ? enroll.voiceId : null
  })
  Speakers.patch(speaker.id, { mappedVoiceId: created.id })
  ctx.log(`说话人 ${speaker.label} → 音色「${created.name}」（${enroll.detail}）`)
  return { voiceId: created.id, name: created.name, label: speaker.label, sourceType: 'cloned', vendorVoiceId: enroll.enrolled ? enroll.voiceId : null, presetName: null, samplePath: sample }
}

/** manifest 合并：本次重配的句子覆盖旧记录，其余保留 */
function mergeManifest(projectId: string, fresh: DubManifestRow[]): DubManifestRow[] {
  const file = projectPaths(projectId).dubManifest
  const prev = readManifestRows(file)
  const byLine = new Map(prev.map((r) => [r.line_id, r]))
  for (const r of fresh) byLine.set(r.line_id, r)
  return [...byLine.values()].sort((a, b) => a.index - b.index)
}

function readManifestRows(file: string): DubManifestRow[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { lines?: DubManifestRow[] }
    return Array.isArray(parsed.lines) ? parsed.lines : []
  } catch {
    return []
  }
}
