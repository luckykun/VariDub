/**
 * 步骤③ 中→英翻译（SPEC-001 §3.3）。
 * 逐句翻译 + 备选译文 ×2（评审决议 R3）+ 俚语/梗标黄 + 译文时长超支标红。
 * 模型一律经 timeRouter 取（§7.7-5）；人工密集环节的「确认重生成」同样遵循时段路由。
 */
import type { JobRecord } from '../../jobs'
import { throwIfCancelled } from '../../jobs'
import type { LineDto, OverflowPolicy, ProjectDto } from '../../../shared/types'
import { emit } from '../../events'
import { Lines } from '../../db/repos'
import { getNum, getSetting } from '../../db/repos/settings'
import { chatJson, mockMode } from '../../bailian/chat'
import { mockTranslation } from '../../bailian/mock'
import { detectSlang, estimateSpeechMs, overflowMs } from '../analyzers'
import { projectPaths } from '../paths'
import { writeTranslationCheckpoint } from '../checkpoints'
import { DEFAULT_TRANSLATE_PROMPT, loadPrompt, makeCtx } from './common'
import { log } from '../../logger'

export interface Step3Options {
  model?: string | null
  /** 强制重译全部句子（默认只译空缺/未确认的） */
  force?: boolean
  batchSize?: number
}

interface TranslateItem {
  index?: number
  en?: string
  alts?: string[]
  slang?: string | null
}

export async function runStep3(project: ProjectDto, job: JobRecord, opts: Step3Options = {}): Promise<LineDto[]> {
  const ctx = makeCtx(project, job, projectPaths(project.id))
  const all = Lines.list(project.id)
  if (all.length === 0) throw new Error('请先完成步骤②（没有可翻译的句子）')
  const speed = getNum('dub.speed') || 1
  const targets = opts.force === true ? all : all.filter((l) => !l.enText.trim() || l.confirmStatus !== 'confirmed')
  if (targets.length === 0) {
    ctx.progress(1, '所有句子已有译文，无需重译')
    return all
  }

  const system = translationSystem()
  const batchSize = Math.max(1, opts.batchSize ?? 10)
  const batches: LineDto[][] = []
  for (let i = 0; i < targets.length; i += batchSize) batches.push(targets.slice(i, i + batchSize))
  const modelDesc = opts.model && opts.model !== 'auto' ? opts.model : 'auto'
  ctx.log(`待译 ${targets.length} 句，分 ${batches.length} 批（模型 ${modelDesc}）`)

  const updates = new Map<string, Partial<LineDto>>()
  let failed = 0
  for (let b = 0; b < batches.length; b += 1) {
    throwIfCancelled(job)
    const batch = batches[b]
    try {
      const items = await translateBatch(batch, opts.model)
      items.forEach((item, i) => {
        const line = batch[i]
        if (!line) return
        const en = String(item.en ?? '').trim()
        if (!en) return
        const windowMs = line.endMs - line.startMs
        const alts = (item.alts ?? []).map((a) => String(a).trim()).filter((a) => a && a !== en).slice(0, altCount())
        const localSlang = detectSlang(line.zhText)
        const note = [item.slang ? String(item.slang) : '', localSlang.map((s) => `${s.word}：${s.note}`).join('；')].filter(Boolean).join(' ｜ ')
        updates.set(line.id, {
          enText: en,
          enAlts: alts,
          slangFlag: note.length > 0,
          slangNote: note || null,
          overflowMs: overflowMs(en, windowMs, speed),
          overflowPolicy: globalPolicy(),
          // 译文变更后必须人工重新确认（P1）
          confirmStatus: 'pending',
          // 下游产物过期：配音/口型需重跑（§7.7-2）
          lipsyncStatus: line.dubWavPath ? line.lipsyncStatus : 'none',
          anchorStale: false
        })
      })
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('step3', `第 ${b + 1} 批翻译失败：${msg}`)
      ctx.log(`第 ${b + 1}/${batches.length} 批失败（已重试）：${msg}`)
    }
    ctx.progress(0.05 + (0.9 * (b + 1)) / batches.length, `翻译批次 ${b + 1}/${batches.length}`)
  }

  for (const [id, patch] of updates) Lines.patch(id, patch)
  if (failed === batches.length) throw new Error(`全部翻译批次失败：请检查 API-KEY / 额度 / 网络（设置页可测试连接）`)

  const lines = Lines.list(project.id)
  writeTranslationCheckpoint(project.id, lines)
  ctx.progress(1, `译文就绪：${updates.size} 句已更新，${lines.filter((l) => l.confirmStatus === 'confirmed').length} 句已确认`)
  emit({ type: 'lines:update', projectId: project.id })
  emit({ type: 'project:update', projectId: project.id })
  return lines
}

/** 单句重译（「重译此句」按钮）：只回传该句，不影响其它句确认状态 */
export async function translateOneLine(project: ProjectDto, lineId: string, model?: string | null): Promise<LineDto | null> {
  const line = Lines.get(lineId)
  if (!line || line.projectId !== project.id) return null
  const items = await translateBatch([line], model)
  const item = items[0]
  if (!item) return null
  const patch = applySingle(line, item)
  Lines.patch(line.id, patch)
  writeTranslationCheckpoint(project.id, Lines.list(project.id))
  emit({ type: 'lines:update', projectId: project.id })
  return Lines.get(line.id)
}

/** 换一批备选（只重生成 alts，保留主译文与确认状态） */
export async function regenerateAlts(project: ProjectDto, lineId: string, model?: string | null): Promise<LineDto | null> {
  const line = Lines.get(lineId)
  if (!line || !line.enText) return null
  const items = await translateBatch([{ ...line, enText: '' }], model)
  const alts = (items[0]?.alts ?? []).map((a) => String(a).trim()).filter((a) => a && a !== line.enText).slice(0, altCount())
  Lines.patch(line.id, { enAlts: alts })
  emit({ type: 'lines:update', projectId: project.id })
  return Lines.get(line.id)
}

function applySingle(line: LineDto, item: TranslateItem): Partial<LineDto> {
  const en = String(item.en ?? '').trim() || line.enText
  const windowMs = line.endMs - line.startMs
  const speed = getNum('dub.speed') || 1
  const localSlang = detectSlang(line.zhText)
  const note = [item.slang ? String(item.slang) : '', localSlang.map((s) => `${s.word}：${s.note}`).join('；')].filter(Boolean).join(' ｜ ')
  return {
    enText: en,
    enAlts: (item.alts ?? []).map((a) => String(a).trim()).filter((a) => a && a !== en).slice(0, altCount()),
    slangFlag: note.length > 0,
    slangNote: note || null,
    overflowMs: overflowMs(en, windowMs, speed),
    confirmStatus: 'pending'
  }
}

async function translateBatch(batch: LineDto[], model?: string | null): Promise<TranslateItem[]> {
  const alts = altCount()
  // 离线/冒烟：用内置语料给出同构结果（主译 + 备选 + 梗注释），只验证编排与门禁（§7.8）
  if (mockMode()) {
    return batch.map((line, i) => {
      const m = mockTranslation(line.zhText, line.index, alts)
      return { index: i, en: m.en, alts: m.enAlts, slang: m.slang }
    })
  }
  const system = translationSystem()
  const rows = batch.map((l, i) => ({
    index: i,
    window_ms: l.endMs - l.startMs,
    zh: l.zhText,
    speaker: `#${i}`
  }))
  const user = `以下 ${rows.length} 句需要翻译。每句给出：
- index：序号（回填时原样返回）
- window_ms：可用时长（毫秒），英文朗读时长必须 ≤ 该值
- zh：中文原文

数据：${JSON.stringify(rows, null, 0)}

请输出 {"lines":[{"index":…,"en":"…","alts":["…","…"],"slang":null 或 "说明"}]}，顺序与数量必须与输入一致。`
  const parsed = await chatJson<{ lines?: TranslateItem[] }>({
    ...(model && model !== 'auto' ? { model } : { stage: 'translate' as const }),
    system,
    user,
    temperature: 0.5,
    maxTokens: 3000,
    scope: 'step3'
  })
  const items = Array.isArray(parsed.lines) ? parsed.lines : []
  if (items.length === 0) throw new Error('翻译返回为空数组')
  // 按 index 对齐；模型漏项时按位置兜底
  const out: TranslateItem[] = []
  for (let i = 0; i < batch.length; i += 1) {
    const found = items.find((x) => Number(x.index) === i) ?? items[i]
    out.push(found ?? {})
  }
  return out
}

function translationSystem(): string {
  const base = loadPrompt('translate', DEFAULT_TRANSLATE_PROMPT)
  const instruction = getSetting('translate.style_instruction').trim()
  const alts = altCount()
  const parts = [base]
  if (instruction) parts.push(`\n【本项目全局风格指令（用户自定义，优先级最高）】\n${instruction}`)
  parts.push(`\n【硬性数量要求】每句必须给出 ${alts} 条备选译文；备选之间与主译文都要有明显差异（长度或措辞）。`)
  return parts.join('\n')
}

export function altCount(): number {
  const n = getNum('translate.alts_count')
  return Math.max(0, Math.min(4, Number.isFinite(n) && n > 0 ? n : 2))
}

export function globalPolicy(): OverflowPolicy {
  const v = getSetting('translate.global_overflow_policy')
  return v === 'freeze' || v === 'compress' || v === 'none' ? v : 'compress'
}

/** 供 UI 与门禁复用：某句在当前策略下的超支量 */
export function lineOverflow(line: LineDto): { estMs: number; overflowMs: number } {
  const speed = getNum('dub.speed') || 1
  const est = estimateSpeechMs(line.enText, speed)
  return { estMs: est, overflowMs: Math.max(0, est - (line.endMs - line.startMs)) }
}
