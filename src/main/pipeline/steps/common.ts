/** 各步骤共享的执行上下文与提示词装载 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectDto } from '../../../shared/types'
import { promptsDir } from '../../paths'
import { appendProjectLog } from '../../logger'
import type { JobRecord } from '../../jobs'
import { setProgress } from '../../jobs'
import { getSetting } from '../../db/repos/settings'
import type { ProjectPaths } from '../paths'

export interface StepCtx {
  projectId: string
  project: ProjectDto
  job: JobRecord
  paths: ProjectPaths
  progress: (ratio: number, message?: string) => void
  log: (line: string) => void
}

export function makeCtx(project: ProjectDto, job: JobRecord, paths: ProjectPaths): StepCtx {
  return {
    projectId: project.id,
    project,
    job,
    paths,
    progress: (ratio, message) => setProgress(job, ratio, message),
    log: (line: string) => {
      appendProjectLog(paths.root, `step${job.dto.step}`, line)
    }
  }
}

/** 提示词模板：可编辑文件优先（resources/prompts/varidub/*.md），缺失时用内嵌默认 */
export function loadPrompt(name: string, fallback: string): string {
  const custom = getSetting('prompt.' + name)
  if (custom && custom.trim().length > 0) return custom
  const file = join(promptsDir(), 'varidub', `${name}.md`)
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim()
    if (text) return text
  }
  return fallback
}

export const DEFAULT_SHOT_PROMPT = `你是综艺节目的分镜助手。输入是按时间顺序抽帧的视频帧与对应时间码（毫秒）。
请只输出 JSON：{"shots":[{"start_ms":整数,"end_ms":整数,"scene_desc":"一句话场景描述（含地点/动作）","persons":["出镜人物代号或身份，如 主持人A","嘉宾B"]}]}
规则：
1) 按镜头切换切分；无法判断切换时按主题变化切分；
2) 相邻分镜必须首尾相接，前一段的 end_ms 等于后一段的 start_ms；
3) 首段 start_ms = 0，末段 end_ms = 视频总时长；
4) 每个分镜不短于 800ms；过长（>20s）的段落按明显动作变化再切；
5) scene_desc 用中文，25 字以内；
6) 不要输出 JSON 以外的文字。`

export const DEFAULT_TRANSLATE_PROMPT = `把中文综艺字幕逐句译成口语化英文。
硬要求：
1) 英文句子的朗读时长必须不超过给定窗口；超支逐句给出更短备选；
2) 俚语/网络梗/谐音梗要传达效果而不是字面，存疑时用 slang 字段说明；
3) 语气、称呼、玩笑强度、节奏与原句一致；
4) 备选译文×2，必须与原句语义一致但措辞或长度明显不同（更短/更口语）。
只输出 JSON：{"lines":[{"index":整数,"en":"译文","alts":["备选1","备选2"],"slang":null 或 "说明"}]}`

export const DEFAULT_TTS_STYLE_PROMPT = `配音说明（注入 TTS 的风格指令）：自然美式口语，综艺节奏，
重音落在信息焦点，句末不拖长音，笑声/叹气等不额外添加。`
