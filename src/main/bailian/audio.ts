/**
 * 百炼语音客户端（SPEC-001 §5.1 环节② ASR / 环节④ 音色克隆 TTS）。
 * ASR 走 OpenAI 兼容模式的 input_audio（带 diarization 提示）；
 * TTS / 音色注册走 DashScope 原生 /api/v1/services/* —— 端点与响应字段可在设置里调整，
 * 解析层对多种返回形态（audio.url / output.audio / 二进制）都做兼容。
 */
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { getApiKey } from '../safeStorage'
import { getSetting } from '../db/repos/settings'
import { log } from '../logger'
import { BailianError, mockMode } from './chat'
import { downloadFile } from '../util/download'
import { runFFmpeg } from '../media/ffmpeg'
import { mockAsrSegments, syntheticWav } from './mock'
import { DEFAULT_TTS_STYLE_PROMPT, loadPrompt } from '../pipeline/steps/common'

export interface AsrSegment {
  startMs: number
  endMs: number
  speaker: string
  text: string
  /** 该句内说话人重叠标记（评审决议 R5：按主说话人，丢弃第二人） */
  overlap?: boolean
}

export interface AsrResult {
  segments: AsrSegment[]
  speakers: string[]
  raw: unknown
}

/** 云端返回的时间码字段名不固定（start/end 或 start_ms/end_ms），兼容两种 */
interface RawAsrSegment {
  start?: number
  end?: number
  startMs?: number
  endMs?: number
  speaker?: string
  text?: string
  overlap?: boolean
}

function nativeBase(): string {
  return (getSetting('api.base_url') || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, '')
}

function authHeaders(json = true): Record<string, string> {
  const key = getApiKey()
  if (!key && !mockMode()) throw new BailianError('未配置 API-KEY：请到「设置」填入百炼 TokenPlan 团队版 KEY')
  return {
    Authorization: `Bearer ${key ?? 'MOCK'}`,
    ...(json ? { 'Content-Type': 'application/json' } : {})
  }
}

async function postJson(path: string, body: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const url = path.startsWith('http') ? path : `${nativeBase()}${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await res.text()
  if (!res.ok) {
    throw new BailianError(`HTTP ${res.status}：${text.slice(0, 400)}`, {
      status: res.status,
      retriable: res.status === 429 || res.status >= 500
    })
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new BailianError(`返回非 JSON：${text.slice(0, 200)}`)
  }
}

function dataUrl(file: string, mime = 'audio/wav'): string {
  const buf = readFileSync(file)
  return `data:${mime};base64,${buf.toString('base64')}`
}

/* ------------------------------------------------------------------- ASR */

const ASR_SYSTEM = `你是语音转写引擎。输入是一段中文综艺音频（人声轨）。
输出严格 JSON：{"segments":[{"start":毫秒整数,"end":毫秒整数,"speaker":"S1","text":"识别出的中文"}],"speakers":["S1"]}
规则：
1) 按句子停顿切分，start/end 为该句在音频中的毫秒时间码；
2) speaker 用 S1/S2/… 标记不同说话人（声纹一致即同一人）；同一时刻重叠的语音只归主说话人；
3) 只输出中文口语原文，保留语气词，不加标点以外的修饰；
4) 无法识别的句子跳过。不要输出 JSON 以外任何字符。`

/**
 * 逐句中文转写 + 说话人分离。
 * 音频经 OpenAI 兼容模式的 input_audio 传入（≤ 3 分钟一段，长音频由调用方分段）。
 */
export async function asrSegments(audioWav: string, model = getSetting('route.stage2.model'), offsetMs = 0): Promise<AsrResult> {
  if (mockMode()) {
    const durationMs = await wavDuration(audioWav)
    const segs = mockAsrSegments(durationMs || 12_000)
    log.info('bailian.asr', `mock 转写 ${segs.length} 句：${basename(audioWav)}`)
    return {
      segments: segs.map((s) => ({ startMs: s.startMs + offsetMs, endMs: s.endMs + offsetMs, speaker: s.speaker, text: s.text })),
      speakers: Array.from(new Set<string>(segs.map((s) => s.speaker))),
      raw: { mock: true }
    }
  }
  const { chatJson } = await import('./chat')
  const parsed = await chatJson<{ segments?: RawAsrSegment[]; speakers?: string[] }>({
    model,
    system: ASR_SYSTEM,
    user: `请转写这段音频（文件名 ${basename(audioWav)}），输出全部句子。`,
    images: [dataUrl(audioWav)],
    temperature: 0,
    maxTokens: 4096
  })
  const segments = (parsed.segments ?? [])
    .map((s) => {
      const startMs = Math.round(Number(s.start ?? s.startMs ?? 0)) + offsetMs
      const endMs = Math.round(Number(s.end ?? s.endMs ?? 0)) + offsetMs
      return {
        startMs,
        endMs: Math.max(startMs + 300, endMs),
        speaker: String(s.speaker ?? 'S1'),
        text: String(s.text ?? '').trim(),
        overlap: s.overlap
      }
    })
    .filter((s) => s.text.length > 0)
  const speakers = parsed.speakers ?? [...new Set(segments.map((s) => s.speaker))]
  return { segments, speakers, raw: parsed }
}

/* ------------------------------------------------------------ 音色注册 */

export interface EnrollResult {
  voiceId: string
  /** 是否真正在云端注册（false = 回退为本地样本驱动） */
  enrolled: boolean
  detail: string
}

/**
 * 用音色样本注册克隆音色（≥20s 干净人声，SPEC-001 §3.2）。
 * 端点/模型名不匹配时不阻断流程：返回 enrolled=false，由 TTS 侧带样本降级。
 */
export async function enrollVoice(sampleWav: string, targetModel: string, prefixName: string): Promise<EnrollResult> {
  if (mockMode()) {
    return { voiceId: `mock-voice-${prefixName}`, enrolled: true, detail: 'Mock 注册' }
  }
  if (!existsSync(sampleWav)) throw new BailianError(`音色样本不存在：${sampleWav}`)
  try {
    const res = await postJson('/services/audio/tts/customization', {
      model: 'qwen-voice-enrollment',
      input: {
        action: 'create',
        target_model: targetModel,
        prefix: prefixName,
        audio: { data: dataUrl(sampleWav) }
      }
    })
    const output = (res.output ?? {}) as Record<string, unknown>
    const voiceId = String(output.voice ?? output.voice_id ?? output.id ?? '')
    if (!voiceId) throw new BailianError(`注册返回缺少 voice id：${JSON.stringify(res).slice(0, 200)}`)
    return { voiceId, enrolled: true, detail: '云端音色已注册' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn('bailian.enroll', `音色注册失败，降级为样本驱动合成：${msg}`)
    return { voiceId: '', enrolled: false, detail: msg }
  }
}

/* ------------------------------------------------------------------ TTS */

export interface SynthesizeInput {
  index?: number
  text: string
  /** 克隆音色 id（enrollVoice 返回）；预置音色传名字 */
  voiceId: string | null
  /** 预置音色名（Sofia/Marcus/播音员/Vivi） */
  presetName?: string | null
  /** 降级路径：无云端音色时用样本驱动 */
  referenceWav?: string | null
  model: string
  speed: number
  pitch: number
  emotion: number
  outWav: string
}

/** 合成一句英文配音，落到 outWav（统一转 44.1k 单声道 WAV） */
export async function synthesize(input: SynthesizeInput): Promise<{ path: string; durationMs: number }> {
  if (mockMode()) {
    const durationMs = Math.max(600, input.text.length * 55)
    await syntheticWav(input.outWav, durationMs, 180 + ((input.index ?? 0) % 5) * 30)
    return { path: input.outWav, durationMs }
  }
  const endpoint = getSetting('api.tts_endpoint') || 'dashscope_tts'
  const body: Record<string, unknown> = {
    model: input.model,
    input: {
      text: input.text,
      ...(input.voiceId ? { voice: input.voiceId } : {}),
      ...(input.presetName && !input.voiceId ? { voice: presetVoiceId(input.presetName) } : {}),
      ...(input.referenceWav && !input.voiceId ? { reference_audio: dataUrl(input.referenceWav) } : {})
    },
    parameters: {
      sample_rate: 44100,
      speed: input.speed,
      pitch: input.pitch,
      instruction: emotionInstruction(input.emotion)
    }
  }
  if (endpoint === 'openai_tts') {
    const url = `${nativeBase().replace(/\/api\/v1$/, '')}/compatible-mode/v1/audio/speech`
    const res = await fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: input.model, input: input.text, voice: input.voiceId ?? input.presetName ?? 'sofia', speed: input.speed }), signal: AbortSignal.timeout(180_000) })
    if (!res.ok) throw new BailianError(`TTS HTTP ${res.status}：${(await res.text()).slice(0, 300)}`, { status: res.status, retriable: true })
    const buf = Buffer.from(await res.arrayBuffer())
    const { writeFileSync } = await import('node:fs')
    const tmp = `${input.outWav}.raw`
    writeFileSync(tmp, buf)
    return normalizeToWav(tmp, input.outWav)
  }
  const res = await postJson('/services/audio/tts/SentenceSynthesis', body, 180_000)
  const audioUrl = pickAudioUrl(res)
  if (audioUrl) {
    const tmp = `${input.outWav}.dl`
    await downloadFile(audioUrl, tmp)
    return normalizeToWav(tmp, input.outWav)
  }
  const b64 = pickAudioBase64(res)
  if (b64) {
    const { writeFileSync } = await import('node:fs')
    const tmp = `${input.outWav}.raw`
    writeFileSync(tmp, Buffer.from(b64, 'base64'))
    return normalizeToWav(tmp, input.outWav)
  }
  throw new BailianError(`TTS 返回中找不到音频：${JSON.stringify(res).slice(0, 300)}`)
}

function presetVoiceId(name: string): string {
  const map: Record<string, string> = { Sofia: 'sofia', Marcus: 'marcus', 播音员: 'announcer', Vivi: 'vivi' }
  return map[name] ?? name.toLowerCase()
}

/** 注入 TTS 的风格指令：可编辑提示词（resources/prompts/varidub/tts_style.md）+ 本步情绪档位 */
function emotionInstruction(emotion: number): string {
  const level = emotion >= 0.75 ? '综艺感强、情绪饱满、语调起伏明显' : emotion >= 0.4 ? '自然口语、轻度综艺感' : '平稳叙述'
  const style = loadPrompt('tts_style', DEFAULT_TTS_STYLE_PROMPT).replace(/\s+/g, ' ').trim()
  return `${style} 当前档位：${level}。`.slice(0, 500)
}

function pickAudioUrl(res: Record<string, unknown>): string | null {
  const output = res.output as Record<string, unknown> | undefined
  const candidates = [
    (output?.audio as Record<string, unknown> | undefined)?.url,
    output?.audio_url,
    output?.url,
    (res as Record<string, unknown>).audio_url
  ]
  for (const c of candidates) if (typeof c === 'string' && c.startsWith('http')) return c
  return null
}

function pickAudioBase64(res: Record<string, unknown>): string | null {
  const output = res.output as Record<string, unknown> | undefined
  const audio = output?.audio as Record<string, unknown> | undefined
  for (const c of [audio?.data, output?.data, (res as Record<string, unknown>).audio]) {
    if (typeof c === 'string' && c.length > 100) return c
  }
  return null
}

/** 任意音频格式 → 44.1k 单声道 WAV */
export async function normalizeToWav(src: string, outWav: string): Promise<{ path: string; durationMs: number }> {
  const { runFFmpeg: run } = await import('../media/ffmpeg')
  await run(['-y', '-i', src, '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '1', outWav], { timeoutMs: 120_000 })
  const { rmSync } = await import('node:fs')
  try {
    rmSync(src)
  } catch {
    /* 忽略临时文件清理失败 */
  }
  const durationMs = await wavDuration(outWav)
  return { path: outWav, durationMs }
}

export async function wavDuration(file: string): Promise<number> {
  try {
    const stderr = await runFFmpeg(['-hide_banner', '-i', file, '-f', 'null', '-'], { timeoutMs: 60_000 })
    const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr)
    if (!m) return 0
    return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]) * 10
  } catch {
    return 0
  }
}

/** 相似度评估：优先用云端返回，缺失时用时长/声学近似度兜底（不静默造假：来源标记在 detail） */
export interface SimilarityResult {
  score: number
  method: 'vendor' | 'estimated'
  detail: string
}

export async function estimateSimilarity(referenceWav: string, dubWav: string, vendorScore?: number | null): Promise<SimilarityResult> {
  if (typeof vendorScore === 'number' && vendorScore > 0) {
    return { score: clamp(vendorScore), method: 'vendor', detail: '云端返回相似度' }
  }
  const ref = await loudness(referenceWav)
  const dub = await loudness(dubWav)
  // 估算式：音色/响度接近度 + 时长合理性，仅作为红旗筛查，不宣称是声纹相似度
  const loudnessGap = Math.abs(ref.mean - dub.mean)
  const base = 96 - Math.min(30, loudnessGap * 1.6)
  return { score: clamp(Math.round(base)), method: 'estimated', detail: `估算值（响度差 ${loudnessGap.toFixed(1)}dB），非声纹比对` }
}

async function loudness(file: string): Promise<{ mean: number }> {
  if (!existsSync(file)) return { mean: -91 }
  try {
    const stderr = await runFFmpeg(['-hide_banner', '-i', file, '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'], { timeoutMs: 60_000 })
    const m = /RMS level dB:\s*(-?[\d.]+)/.exec(stderr)
    return { mean: m ? Number(m[1]) : -91 }
  } catch {
    return { mean: -91 }
  }
}

function clamp(v: number): number {
  if (v > 1) return Math.round(Math.min(100, v))
  return Math.round(Math.max(0, Math.min(1, v)) * 100)
}

export function audioReady(file: string): boolean {
  return existsSync(file)
}
