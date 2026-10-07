/**
 * 百炼 OpenAI 兼容客户端（步骤① 视觉分镜 / 步骤③ 翻译，SPEC-001 §5.1）。
 * 模型名一律经 timeRouter 取得；失败自动重试 2 次（§3 通用规则）。
 */
import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getApiKey } from '../safeStorage'
import { getSetting, isMock } from '../db/repos/settings'
import type { RouteStage } from '../../shared/types'
import { modelFor } from './timeRouter'
import { log } from '../logger'

export class BailianError extends Error {
  retriable: boolean
  status: number | null
  constructor(message: string, opts: { retriable?: boolean; status?: number | null } = {}) {
    super(message)
    this.name = 'BailianError'
    this.retriable = opts.retriable ?? false
    this.status = opts.status ?? null
  }
}

export function mockMode(): boolean {
  return isMock()
}

function baseUrl(): string {
  return getSetting('api.compatible_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
}

function client(): OpenAI {
  const key = getApiKey()
  if (!key && !mockMode()) throw new BailianError('未配置 API-KEY：请到「设置」填入百炼 TokenPlan 团队版 KEY')
  return new OpenAI({ apiKey: key ?? 'MOCK', baseURL: baseUrl(), timeout: 180_000, maxRetries: 0 })
}

export interface ChatOptions {
  /** 二选一：stage 走时段路由；model 手动指定 */
  stage?: RouteStage
  model?: string
  system: string
  user: string
  /** 视觉输入（帧图 base64 data URL） */
  images?: string[]
  temperature?: number
  maxTokens?: number
  json?: boolean
  /** 失败重试次数，默认 2（SPEC-001 §3） */
  retries?: number
  scope?: string
}

function buildMessages(opts: ChatOptions): ChatCompletionMessageParam[] {
  const userContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
  for (const img of opts.images ?? []) userContent.push({ type: 'image_url', image_url: { url: img } })
  userContent.push({ type: 'text', text: opts.user })
  return [
    { role: 'system', content: opts.system },
    { role: 'user', content: userContent }
  ]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 一次对话补全（含重试）；返回文本内容 */
export async function chat(opts: ChatOptions): Promise<string> {
  const model = opts.model ?? modelFor(opts.stage ?? 'translate')
  const maxRetries = opts.retries ?? 2
  const messages = buildMessages(opts)
  let lastError: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await client().chat.completions.create({
        model,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {})
      })
      const text = response.choices?.[0]?.message?.content ?? ''
      if (!text.trim()) throw new BailianError(`${model} 返回空内容`, { retriable: true })
      return text
    } catch (err) {
      lastError = err
      const retriable = isRetriable(err)
      log.warn('bailian.chat', `${model} 第 ${attempt + 1} 次失败：${describe(err)}${retriable ? '' : '（不重试）'}`)
      if (!retriable || attempt === maxRetries) break
      await sleep(1000 * (attempt + 1))
    }
  }
  throw new BailianError(`云端调用失败（${model}）：${describe(lastError)}`, {
    retriable: true,
    status: statusOf(lastError)
  })
}

/** JSON 输出解析：容忍 ```json 包裹与前后噪声 */
export async function chatJson<T>(opts: ChatOptions): Promise<T> {
  const raw = await chat({ ...opts, json: true })
  return parseJsonLoose<T>(raw)
}

export function parseJsonLoose<T>(raw: string): T {
  const text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1].trim() : text
  const start = body.search(/[[{]/)
  const candidate = start > 0 ? body.slice(start) : body
  try {
    return JSON.parse(candidate) as T
  } catch {
    // 尾部截断时尝试补齐括号
    const fixed = balanceBraces(candidate)
    return JSON.parse(fixed) as T
  }
}

function balanceBraces(text: string): string {
  const stack: string[] = []
  for (const ch of text) {
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  return text + stack.reverse().join('')
}

function isRetriable(err: unknown): boolean {
  const status = statusOf(err)
  if (status === 429) return true
  if (status && status >= 500) return true
  const msg = describe(err).toLowerCase()
  return /timeout|econn|etimedout|socket|network|rate|限流|超时/.test(msg)
}

function statusOf(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status
    if (typeof s === 'number') return s
  }
  return null
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  if (mockMode()) return { ok: true, detail: 'Mock 模式（未发起真实请求）' }
  try {
    const text = await chat({ model: modelFor('translate'), system: '你是连通性测试助手。', user: '只回复 OK', maxTokens: 8, retries: 0 })
    return { ok: true, detail: `连通：${text.slice(0, 40)}` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
