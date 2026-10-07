/**
 * 无外部依赖的启发式分析器（SPEC-001 §2.1 PySceneDetect 兜底、§3.2 样本质量、§3.3 超支检测）。
 * 全部基于 ffmpeg 滤镜输出，不引入 opencv/skimage。
 */
import { existsSync } from 'node:fs'
import { runFFmpeg, volumeStats } from '../media/ffmpeg'
import { log } from '../logger'

export interface CutCandidate {
  atMs: number
  score: number
  method: 'scene_filter' | 'blackdetect'
}

/**
 * 分镜兜底切分：先用 ffmpeg `select=gt(scene,th)` 逐帧场景差，
 * 无结果时用 blackdetect（转场黑场）作为切点。
 * 返回内部切点（不含首尾）。
 */
export async function detectSceneChanges(videoPath: string, durationMs: number, threshold = 0.3): Promise<CutCandidate[]> {
  const cuts = await sceneFilterCuts(videoPath, threshold)
  if (cuts.length > 0) return cuts
  const black = await blackdetectCuts(videoPath)
  if (black.length > 0) return black
  log.warn('analyzers', '本地分镜检测未找到切点，退化为均分（可在步骤①手动拖动切点）')
  return []
}

async function sceneFilterCuts(videoPath: string, threshold: number): Promise<CutCandidate[]> {
  try {
    const stderr = await runFFmpeg(
      [
        '-hide_banner',
        '-i',
        videoPath,
        '-vf',
        `select='gt(scene,${threshold})',showinfo`,
        '-an',
        '-f',
        'null',
        '-'
      ],
      { timeoutMs: 300_000 }
    )
    const cuts: CutCandidate[] = []
    const seen = new Set<number>()
    const re =/pts_time:\s*([\d.]+)/g
    let m: RegExpExecArray | null = re.exec(stderr)
    while (m !== null) {
      const atMs = Math.round(Number(m[1]) * 1000)
      if (atMs > 250 && !seen.has(atMs)) {
        seen.add(atMs)
        cuts.push({ atMs, score: threshold, method: 'scene_filter' })
      }
      m = re.exec(stderr)
    }
    return cuts.sort((a, b) => a.atMs - b.atMs)
  } catch (err) {
    log.warn('analyzers', `scene 检测失败：${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function blackdetectCuts(videoPath: string): Promise<CutCandidate[]> {
  try {
    const stderr = await runFFmpeg(
      ['-hide_banner', '-i', videoPath, '-vf', 'blackdetect=d=0.08:pix_th=0.10', '-an', '-f', 'null', '-'],
      { timeoutMs: 300_000 }
    )
    const cuts: CutCandidate[] = []
    const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g
    let m: RegExpExecArray | null = re.exec(stderr)
    while (m !== null) {
      const mid = Math.round(((Number(m[1]) + Number(m[2])) / 2) * 1000)
      if (mid > 250) cuts.push({ atMs: mid, score: 0.2, method: 'blackdetect' })
      m = re.exec(stderr)
    }
    return cuts.sort((a, b) => a.atMs - b.atMs)
  } catch {
    return []
  }
}

/* ---------------------------------------------------- 时长与超支估算 */

const AVERAGE_ENGLISH_SYLLABLE_MS = 260
const WORD_PUNCTUATION_PAUSE_MS = 90

/** 音节近似计数（元音组 + 独立 y/w，末尾 e 不发音） */
export function estimateSyllables(text: string): number {
  const clean = text.toLowerCase().replace(/[^a-z' ]/g, ' ')
  let total = 0
  for (const word of clean.split(/\s+/).filter(Boolean)) {
    const w = word.replace(/'/g, '')
    const groups = w.match(/[aeiouy]+/g)
    let n = groups ? groups.length : 1
    if (/[^aeiou]e$/.test(w) && n > 1) n -= 1
    total += Math.max(1, n)
  }
  return total
}

/** 英文朗读时长估算（用于「译文超支」标红判定；speed 影响语速） */
export function estimateSpeechMs(text: string, speed = 1): number {
  if (!text.trim()) return 0
  const syllables = estimateSyllables(text)
  const pauses = (text.match(/[,.!?;:]/g) ?? []).length * WORD_PUNCTUATION_PAUSE_MS
  const base = syllables * AVERAGE_ENGLISH_SYLLABLE_MS * (120 / 60) / 2
  return Math.round(Math.max(400, (base + pauses) / Math.max(0.6, speed)))
}

/** 中文朗读时长估算（校验原句锚点是否合理） */
export function estimateChineseMs(text: string): number {
  const chars = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length
  const latin = (text.match(/[a-zA-Z]+/g) ?? []).length
  return Math.round(Math.max(300, chars * 235 + latin * 320))
}

export function overflowMs(enText: string, windowMs: number, speed = 1): number {
  const est = estimateSpeechMs(enText, speed)
  return Math.max(0, Math.round(est - windowMs))
}

/* ------------------------------------------------------------ 俚语/梗 */

const SLANG_LEXICON: Array<{ word: string; note: string }> = [
  { word: '下饭', note: '网络梗：适合配饭/看着香，英文宜意译' },
  { word: '拉胯', note: '网络梗：掉链子、表现差' },
  { word: '摆烂', note: '网络梗：破罐破摔' },
  { word: '内卷', note: '社会热词：过度竞争（rat race / grind）' },
  { word: '躺平', note: '社会热词：放弃竞争（lying flat）' },
  { word: '破防', note: '网络梗：情绪被击中' },
  { word: '上头', note: '网络梗：一时冲动/上瘾' },
  { word: '封神', note: '夸张用语：一战成名' },
  { word: '整活', note: '网络梗：搞花样' },
  { word: '翻车', note: '网络梗：现场失误' },
  { word: '毒奶', note: '电竞梗：反向祝福（jinx）' },
  { word: '割韭菜', note: '社会梗：反复收割普通人' },
  { word: '磕CP', note: '粉圈用语：喜欢一对组合' },
  { word: 'C位', note: '娱乐圈用语：中心位置' },
  { word: '划水', note: '网络梗：摸鱼/不尽力' },
  { word: '摸鱼', note: '网络梗：偷懒' },
  { word: '逆风翻盘', note: '电竞梗：劣势反超' },
  { word: '卖关子', note: '口语：吊胃口' },
  { word: '双标', note: '口语：双重标准' },
  { word: '甩锅', note: '口语：推卸责任' },
  { word: '带节奏', note: '网络梗：煽动舆论' },
  { word: '拉踩', note: '粉圈用语：捧一踩一' },
  { word: '塌房', note: '粉圈用语：偶像人设崩塌' },
  { word: '彩蛋', note: '影视用语：post-credits' },
  { word: '名场面', note: '网络梗：经典片段' },
  { word: '神仙打架', note: '网络梗：高手对决' }
]

export interface SlangHit {
  word: string
  note: string
}

export function detectSlang(zhText: string): SlangHit[] {
  return SLANG_LEXICON.filter((s) => zhText.includes(s.word))
}

/* ------------------------------------------------- 音色样本质量校验 */

export interface SampleQuality {
  level: 'ok' | 'short' | 'noisy'
  note: string
  durationMs: number
  meanDb: number
  peakDb: number
}

/** 样本 <15s 或信噪比差 → 标黄（SPEC-001 §3.2） */
export async function checkVoiceSample(sampleWav: string, durationMs: number, refMeanDb: number | null = null): Promise<SampleQuality> {
  if (!existsSync(sampleWav)) {
    return { level: 'short', note: '样本文件缺失', durationMs: Math.round(durationMs), meanDb: -91, peakDb: -91 }
  }
  const stats = await volumeStats(sampleWav, 0, Math.max(1000, Math.round(durationMs)))
  const quiet = refMeanDb === null ? -45 : refMeanDb - 12
  if (durationMs < 15_000) {
    return { level: 'short', note: `样本 ${(durationMs / 1000).toFixed(1)}s < 15s，克隆稳定性下降`, durationMs: Math.round(durationMs), meanDb: stats.mean, peakDb: stats.max }
  }
  if (stats.mean < quiet || stats.max < -28) {
    return { level: 'noisy', note: `响度偏低（均值 ${stats.mean.toFixed(1)}dB / 峰值 ${stats.max.toFixed(1)}dB），疑含大量静音或背景`, durationMs: Math.round(durationMs), meanDb: stats.mean, peakDb: stats.max }
  }
  return { level: 'ok', note: `样本 ${(durationMs / 1000).toFixed(1)}s · 均值 ${stats.mean.toFixed(1)}dB`, durationMs: Math.round(durationMs), meanDb: stats.mean, peakDb: stats.max }
}

/* --------------------------------------- 一致性评分（SSIM 近似，非人脸比对） */

export async function frameConsistency(original: string, stylized: string): Promise<number | null> {
  if (!existsSync(original) || !existsSync(stylized)) return null
  try {
    const stderr = await runFFmpeg(
      ['-hide_banner', '-i', stylized, '-i', original, '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-'],
      { timeoutMs: 120_000 }
    )
    const m = /All:([\d.e-]+)/.exec(stderr)
    if (!m) return null
    const raw = Number(m[1])
    if (!Number.isFinite(raw) || raw < 0) return null
    // SSIM 在风格迁移下天然偏低（0.15~0.6），映射到 0.55~0.95 显示区间
    const mapped = 0.55 + Math.min(0.4, raw * 0.7)
    return Math.round(mapped * 100) / 100
  } catch {
    return null
  }
}

/** 把 SSIM 的 U 形关系转成「结构保持度」提示语，避免 UI 误读为语义相似度 */
export function consistencyHint(score: number | null): string {
  if (score === null) return '无一致性评分（本地结构比对不可用）'
  if (score >= 0.85) return '构图与主体高度保持'
  if (score >= 0.75) return '构图基本一致'
  if (score >= 0.65) return '一致性偏低，建议重跑'
  return '构图偏移明显，需重跑或调参'
}
