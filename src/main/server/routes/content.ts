/**
 * 内容编辑接口（SPEC-001 §3 各步的人工操作 + §7.7-2 锚点真值传递）。
 * 句级时间锚点被改动 → 下游配音/口型产物过期（anchorStale）；分镜切/合只重排索引，不动句子锚点。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { LineDto, ProjectDto, ShotDto, SpeakerDto } from '../../../shared/types'
import type { LinePatchRequest, ShotPatchRequest, SpeakerPatchRequest, VoiceCreateRequest } from '../../../shared/api'
import { Lines, Projects, Shots, Speakers, Voices } from '../../db/repos'
import { emit } from '../../events'
import { log } from '../../logger'
import { newId } from '../../util/id'
import { GateError } from '../../pipeline/runner'
import { projectPaths } from '../../pipeline/paths'
import { writeShotsCheckpoint } from '../../pipeline/checkpoints'
import { checkVoiceSample } from '../../pipeline/analyzers'
import { cutAudioSegment, wavDurationMs } from '../../media/ffmpeg'
import { enrollVoice, synthesize, wavDuration } from '../../bailian/audio'
import { PRESET_VOICES } from '../../../shared/models'
import { getSetting } from '../../db/repos/settings'
import { previewDir } from '../dto'

export function registerContentRoutes(app: FastifyInstance): void {
  /* -------------------------------------------------------------- 分镜 */

  app.get('/api/projects/:id/shots', async (req) => Shots.list((req.params as { id: string }).id))

  app.patch('/api/shots/:id', async (req) => {
    const id = (req.params as { id: string }).id
    const shot = needShot(id)
    const patch = normalizeShotPatch((req.body ?? {}) as ShotPatchRequest)
    Shots.patch(id, patch)
    // 拖动切点会改变分镜时长（步骤⑤ 动态化时长依据），同步检查点
    if (patch.startMs !== undefined || patch.endMs !== undefined || patch.sceneDesc !== undefined || patch.persons !== undefined) {
      writeShotsCheckpoint(shot.projectId, Shots.list(shot.projectId))
    }
    emit({ type: 'shots:update', projectId: shot.projectId })
    return needShot(id)
  })

  app.post('/api/projects/:id/shots/split', async (req) => {
    const projectId = (req.params as { id: string }).id
    needProject(projectId)
    const body = (req.body ?? {}) as { shotId?: string; atMs?: number }
    const shots = Shots.list(projectId)
    const shot = shots.find((s) => s.id === body.shotId)
    const atMs = Math.round(body.atMs ?? 0)
    if (!shot) throw new GateError('分镜不存在')
    if (!atMs || atMs <= shot.startMs + 300 || atMs >= shot.endMs - 300) throw new GateError('切点必须在分镜内部且两侧各留 0.3s 以上')
    const second: ShotDto = {
      ...shot,
      id: newId('sht'),
      index: shot.index + 1,
      startMs: atMs,
      sceneDesc: '',
      acceptStatus: 'pending',
      frame3dPath: null,
      clip3dPath: null,
      consistencyScore: null,
      isPilot: false,
      source: 'manual',
      error: null
    }
    const rebuilt: ShotDto[] = []
    for (const s of shots) {
      if (s.id !== shot.id) {
        rebuilt.push({ ...s, index: rebuilt.length })
        continue
      }
      rebuilt.push({ ...s, index: rebuilt.length, endMs: atMs })
      rebuilt.push({ ...second, index: rebuilt.length })
    }
    Shots.replaceAll(projectId, rebuilt.map((s) => ({ ...s, projectId })))
    reassignLines(projectId)
    writeShotsCheckpoint(projectId, Shots.list(projectId))
    emit({ type: 'shots:update', projectId })
    return Shots.list(projectId)
  })

  app.post('/api/projects/:id/shots/merge', async (req) => {
    const projectId = (req.params as { id: string }).id
    needProject(projectId)
    const body = (req.body ?? {}) as { shotId?: string }
    const shots = Shots.list(projectId)
    const idx = shots.findIndex((s) => s.id === body.shotId)
    if (idx < 0 || idx >= shots.length - 1) throw new GateError('只能与后一个分镜合并')
    const merged: ShotDto = {
      ...shots[idx],
      endMs: shots[idx + 1].endMs,
      sceneDesc: [shots[idx].sceneDesc, shots[idx + 1].sceneDesc].filter(Boolean).join('；'),
      persons: [...new Set([...shots[idx].persons, ...shots[idx + 1].persons])],
      acceptStatus: 'pending',
      frame3dPath: null,
      clip3dPath: null,
      consistencyScore: null,
      source: 'manual',
      error: null
    }
    const rebuilt = [...shots.slice(0, idx), merged, ...shots.slice(idx + 2)].map((s, i) => ({ ...s, index: i }))
    Shots.replaceAll(projectId, rebuilt.map((s) => ({ ...s, projectId })))
    reassignLines(projectId)
    writeShotsCheckpoint(projectId, Shots.list(projectId))
    emit({ type: 'shots:update', projectId })
    return Shots.list(projectId)
  })

  app.delete('/api/shots/:id', async (req) => {
    const id = (req.params as { id: string }).id
    const shot = needShot(id)
    const rest = Shots.list(shot.projectId).filter((s) => s.id !== id).map((s, i) => ({ ...s, index: i }))
    Shots.replaceAll(shot.projectId, rest.map((s) => ({ ...s, projectId: shot.projectId })))
    reassignLines(shot.projectId)
    writeShotsCheckpoint(shot.projectId, Shots.list(shot.projectId))
    emit({ type: 'shots:update', projectId: shot.projectId })
    return { ok: true, shots: Shots.list(shot.projectId) }
  })

  /* -------------------------------------------------------------- 句子 */

  app.get('/api/projects/:id/lines', async (req) => Lines.list((req.params as { id: string }).id))

  app.patch('/api/lines/:id', async (req) => {
    const id = (req.params as { id: string }).id
    const line = needLine(id)
    const body = (req.body ?? {}) as LinePatchRequest
    const patch: Partial<LineDto> = {}
    if (body.zhText !== undefined) patch.zhText = body.zhText
    if (body.enText !== undefined) patch.enText = body.enText.trim()
    if (body.enAlts !== undefined) patch.enAlts = body.enAlts
    if (body.speakerId !== undefined) patch.speakerId = body.speakerId
    if (body.shotId !== undefined) patch.shotId = body.shotId
    if (body.overflowPolicy !== undefined) patch.overflowPolicy = body.overflowPolicy
    if (body.confirmStatus !== undefined) patch.confirmStatus = body.confirmStatus
    const anchorChanged =
      (body.startMs !== undefined && body.startMs !== line.startMs) || (body.endMs !== undefined && body.endMs !== line.endMs)
    if (body.startMs !== undefined) patch.startMs = Math.max(0, Math.round(body.startMs))
    if (body.endMs !== undefined) patch.endMs = Math.max(patch.startMs ?? line.startMs, Math.round(body.endMs))
    if (anchorChanged || body.enText !== undefined || body.zhText !== undefined) {
      // 锚点或文本变化：下游配音/口型过期（SPEC-001 §7.7-2）
      patch.anchorStale = true
      if (line.dubWavPath) patch.lipsyncStatus = 'stale'
    }
    if (body.enText !== undefined) {
      const windowMs = (patch.endMs ?? line.endMs) - (patch.startMs ?? line.startMs)
      const { lineOverflow } = await import('../../pipeline/steps/step3')
      patch.overflowMs = lineOverflow({ ...line, enText: patch.enText ?? '', startMs: patch.startMs ?? line.startMs, endMs: patch.endMs ?? line.endMs }).overflowMs
      patch.confirmStatus = 'confirmed'
      void windowMs
    }
    Lines.patch(id, patch)
    emit({ type: 'lines:update', projectId: line.projectId })
    return needLine(id)
  })

  app.post('/api/lines/:id/confirm', async (req) => {
    const id = (req.params as { id: string }).id
    const line = needLine(id)
    const body = (req.body ?? {}) as { confirmed?: boolean }
    const confirmed = body.confirmed !== false
    if (confirmed && !line.enText.trim()) throw new GateError('英文译文为空，不能确认')
    Lines.patch(id, { confirmStatus: confirmed ? 'confirmed' : 'pending' })
    emit({ type: 'lines:update', projectId: line.projectId })
    return { ok: true, line: needLine(id) }
  })

  app.post('/api/projects/:id/lines/confirm-all', async (req) => {
    const projectId = (req.params as { id: string }).id
    needProject(projectId)
    const ids = Lines.list(projectId).filter((l) => l.enText.trim() && l.confirmStatus !== 'confirmed').map((l) => l.id)
    Lines.setMany(ids, { confirmStatus: 'confirmed' })
    emit({ type: 'lines:update', projectId })
    return { confirmed: ids.length, lines: Lines.list(projectId) }
  })

  /* ------------------------------------------------------------ 说话人 */

  app.get('/api/projects/:id/speakers', async (req) => Speakers.list((req.params as { id: string }).id))

  app.patch('/api/speakers/:id', async (req) => {
    const id = (req.params as { id: string }).id
    const speaker = needSpeaker(id)
    const body = (req.body ?? {}) as SpeakerPatchRequest
    const patch: Partial<SpeakerDto> = {}
    if (body.label?.trim()) patch.label = body.label.trim().slice(0, 24)
    if (body.mappedVoiceId !== undefined) patch.mappedVoiceId = body.mappedVoiceId
    Speakers.patch(id, patch)
    emit({ type: 'speakers:update', projectId: speaker.projectId })
    return needSpeaker(id)
  })

  /** 手动重选音色区间（样本 <15s 或信噪比差时用） */
  app.post('/api/speakers/:id/resample', async (req) => {
    const id = (req.params as { id: string }).id
    const speaker = needSpeaker(id)
    const body = (req.body ?? {}) as { startMs?: number; endMs?: number }
    const startMs = Math.round(body.startMs ?? speaker.sampleStartMs ?? 0)
    const endMs = Math.round(body.endMs ?? speaker.sampleEndMs ?? 0)
    const paths = projectPaths(speaker.projectId)
    if (!existsSync(paths.vocalsWav)) throw new GateError('还没有人声轨（vocals.wav）：请先运行步骤②')
    if (endMs <= startMs + 1000) throw new GateError('区间至少 1 秒')
    const project = needProject(speaker.projectId)
    const dest = paths.sampleOf(speaker.id)
    await cutAudioSegment(paths.vocalsWav, startMs, endMs, dest, 44100)
    const durationMs = await wavDuration(dest)
    const quality = await checkVoiceSample(dest, durationMs)
    Speakers.patch(speaker.id, {
      sampleWavPath: dest,
      sampleStartMs: startMs,
      sampleEndMs: endMs,
      sampleQuality: quality.level,
      sampleQualityNote: quality.note,
      mappedVoiceId: null
    })
    log.info('content', `${project.name} 说话人 ${speaker.label} 重选样本 ${startMs}-${endMs}ms（${quality.level}）`)
    emit({ type: 'speakers:update', projectId: speaker.projectId })
    return needSpeaker(id)
  })

  app.get('/api/projects/:id/assign-speaker', async (req) => {
    const projectId = (req.params as { id: string }).id
    return { speakers: Speakers.list(projectId), lines: Lines.list(projectId) }
  })

  /* -------------------------------------------------------------- 音色 */

  app.get('/api/voices', async (req) => {
    const query = req.query as { kind?: string }
    const all = Voices.list()
    if (query.kind === 'cloned') return all.filter((v) => v.sourceType === 'cloned')
    if (query.kind === 'preset') return all.filter((v) => v.sourceType === 'preset')
    return all
  })

  app.post('/api/voices', async (req) => {
    const body = (req.body ?? {}) as VoiceCreateRequest
    const name = (body.name ?? '').trim().slice(0, 40)
    if (!name) throw new GateError('请填写音色名称')
    const sample = (body.samplePath ?? '').trim()
    if (!sample || !existsSync(sample)) throw new GateError('请选择一个本地 WAV/音频样本')
    const model = getSetting('route.stage4.model')
    const durationMs = await wavDuration(sample)
    if (durationMs < 3000) throw new GateError(`样本太短（${(durationMs / 1000).toFixed(1)}s）：克隆至少需要 3 秒清晰人声`)
    const enroll = await enrollVoice(sample, model, `lib_${name.replace(/[^0-9A-Za-z]/g, '').slice(0, 12) || newId('v').slice(1, 9)}`)
    const voice = Voices.create({
      name,
      sourceType: 'cloned',
      tags: body.tags ?? ['手动克隆'],
      samplePath: sample,
      durationMs,
      vendorVoiceId: enroll.enrolled ? enroll.voiceId : null
    })
    emit({ type: 'voices:update' })
    return voice
  })

  app.patch('/api/voices/:id', async (req) => {
    const id = (req.params as { id: string }).id
    const voice = Voices.get(id)
    if (!voice) throw new GateError('音色不存在')
    const body = (req.body ?? {}) as { name?: string; tags?: string[] }
    const patch: Record<string, unknown> = {}
    if (body.name?.trim()) patch.name = body.name.trim().slice(0, 40)
    if (body.tags) patch.tags = body.tags.slice(0, 8)
    Voices.patch(id, patch)
    emit({ type: 'voices:update' })
    return Voices.get(id)
  })

  app.delete('/api/voices/:id', async (req) => {
    const id = (req.params as { id: string }).id
    const voice = Voices.get(id)
    if (!voice) throw new GateError('音色不存在')
    // 删掉克隆音色后，把引用它的说话人映射清空（否则会指向不存在的音色）
    for (const p of Projects.list()) {
      for (const s of Speakers.list(p.id).filter((x) => x.mappedVoiceId === id)) Speakers.patch(s.id, { mappedVoiceId: null })
    }
    Voices.remove(id)
    emit({ type: 'voices:update' })
    return { ok: true }
  })

  /** 音色试听：用该音色朗读一句固定样例 */
  app.post('/api/voices/:id/preview', async (req) => {
    const id = (req.params as { id: string }).id
    const voice = Voices.get(id)
    if (!voice) throw new GateError('音色不存在')
    const body = (req.body ?? {}) as { text?: string }
    const text = (body.text ?? 'This is how the cloned voice sounds in English.').trim().slice(0, 160)
    const model = getSetting('route.stage4.model')
    const dest = join(previewDir(), `${voice.id}.wav`)
    await synthesize({
      index: 0,
      text,
      voiceId: voice.vendorVoiceId,
      presetName: voice.sourceType === 'preset' ? voice.name : null,
      referenceWav: voice.samplePath,
      model,
      speed: 1,
      pitch: 0,
      emotion: 0.5,
      outWav: dest
    })
    return { path: dest, exists: existsSync(dest) }
  })

  app.get('/api/preset-voices', async () => ({ voices: PRESET_VOICES }))
}

/* ------------------------------------------------------------------ 内部 */

function normalizeShotPatch(body: ShotPatchRequest): Partial<ShotDto> {
  const patch: Partial<ShotDto> = {}
  if (body.startMs !== undefined) patch.startMs = Math.max(0, Math.round(body.startMs))
  if (body.endMs !== undefined) patch.endMs = Math.round(body.endMs)
  if (body.sceneDesc !== undefined) patch.sceneDesc = body.sceneDesc
  if (body.persons !== undefined) patch.persons = body.persons.slice(0, 8)
  if (body.acceptStatus !== undefined) patch.acceptStatus = body.acceptStatus
  if (body.isPilot !== undefined) patch.isPilot = body.isPilot
  if (body.styleId !== undefined) patch.styleId = body.styleId
  if (body.source !== undefined) patch.source = body.source
  if (patch.endMs !== undefined && patch.startMs !== undefined && patch.endMs <= patch.startMs) {
    patch.endMs = patch.startMs + 300
  }
  return patch
}

/** 分镜切/合后按时间把句子重新归属分镜（锚点不变，只换 shotId） */
function reassignLines(projectId: string): void {
  const shots = Shots.list(projectId)
  if (shots.length === 0) return
  for (const line of Lines.list(projectId)) {
    const mid = (line.startMs + line.endMs) / 2
    const owner = shots.find((s) => mid >= s.startMs && mid < s.endMs) ?? nearestShot(shots, mid)
    if (owner && owner.id !== line.shotId) Lines.patch(line.id, { shotId: owner.id })
  }
  emit({ type: 'lines:update', projectId })
}

function nearestShot(shots: ShotDto[], mid: number): ShotDto | null {
  let best: ShotDto | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const s of shots) {
    const gap = mid < s.startMs ? s.startMs - mid : mid > s.endMs ? mid - s.endMs : 0
    if (gap < bestGap) {
      bestGap = gap
      best = s
    }
  }
  return best
}

function needShot(id: string): ShotDto {
  const shot = Shots.get(id)
  if (!shot) throw new GateError('分镜不存在')
  return shot
}

function needLine(id: string): LineDto {
  const line = Lines.get(id)
  if (!line) throw new GateError('句子不存在')
  return line
}

function needSpeaker(id: string): SpeakerDto {
  const speaker = Speakers.get(id)
  if (!speaker) throw new GateError('说话人不存在')
  return speaker
}

function needProject(id: string): ProjectDto {
  const project = Projects.get(id)
  if (!project) throw new GateError(`项目不存在：${id}`)
  return project
}
