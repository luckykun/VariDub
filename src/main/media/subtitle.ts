/** 双语 SRT 生成（外挂字幕，评审决议 R7：不烧录、不花字） */
import { writeFileSync } from 'node:fs'
import { ensureParent } from '../logger'
import type { LineDto } from '../../shared/types'

function tc(ms: number): string {
  const abs = Math.max(0, Math.round(ms))
  const h = Math.floor(abs / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  const s = Math.floor((abs % 60_000) / 1000)
  const milli = abs % 1000
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`
}

function esc(text: string): string {
  return text.replace(/\r/g, '').trim()
}

/**
 * 字幕时间轴引用句级时间锚点（全链路真值）。
 * bilingual=false 时只输出英文行。
 */
export function buildSrt(lines: LineDto[], bilingual: boolean): string {
  const sorted = [...lines].sort((a, b) => a.startMs - b.startMs)
  const blocks: string[] = []
  for (const line of [...sorted]) {
    const end = Math.max(line.startMs + 400, line.endMs)
    const texts = [esc(line.enText)]
    if (bilingual && esc(line.zhText)) texts.push(esc(line.zhText))
    if (texts.every((t) => t.length === 0)) continue
    blocks.push(`${blocks.length + 1}\n${tc(line.startMs)} --> ${tc(end)}\n${texts.join('\n')}\n`)
  }
  return blocks.join('\n')
}

export function writeSrt(file: string, lines: LineDto[], bilingual: boolean): string {
  ensureParent(file)
  writeFileSync(file, buildSrt(lines, bilingual), 'utf8')
  return file
}
