/**
 * HTTP 契约（SPEC-001 §7.5）：渲染层 ↔ 主进程内嵌 Fastify 的请求/响应类型。
 * 数据本体仍用 types.ts 的 DTO；本文件只描述「接口返回什么」。
 */
import type {
  ArtifactDto,
  JobDto,
  LineDto,
  ModelRouteDto,
  OverflowPolicy,
  ProjectDto,
  SettingsDto,
  ShotDto,
  SpeakerDto,
  StepId,
  StepState,
  VoiceDto
} from './types'

export interface GateIssue {
  level: 'block' | 'warn'
  message: string
}

export interface StepHint {
  step: StepId
  state: StepState
  hint: string
  locked: boolean
  reason: string | null
}

/** 项目工作区一屏所需的全部数据（进入项目页时一次拉取，之后靠 SSE 增量刷新） */
export interface OverviewDto {
  project: ProjectDto
  shots: ShotDto[]
  lines: LineDto[]
  speakers: SpeakerDto[]
  steps: StepHint[]
  gate: Record<StepId, GateIssue[]>
  jobs: JobDto[]
  product: FinalProductDto | null
  gpu: { busy: boolean; label: string | null; jobId: string | null; queueLength: number }
  cloud: { active: number; limit: number }
  sidecar: SidecarViewDto
  artifacts: ArtifactDto[]
}

export interface FinalProductDto {
  name: string
  mp4: string
  srt: string
  report: string
  durationMs: number
  width: number
  height: number
  fps: number
  lipsyncDone: number
  lipsyncSkipped: number
  exportedTo: string | null
}

/** 句级偏差（审片器时间轴标记：绿=通过 / 黄=时长压缩 / 红=口型待修） */
export interface DeviationRowDto {
  index: number
  line_id: string
  speaker: string | null
  target_ms: number
  dub_ms: number | null
  deviation_ms: number | null
  flag: 'green' | 'yellow' | 'red'
  lipsync: LineDto['lipsyncStatus']
  lipsync_offset_ms: number | null
  note: string | null
}

export interface ReportDto {
  projectId: string
  generatedAt: string
  summary: { lines: number; dubbed: number; lipsync_done: number; lipsync_skipped: number; red: number; yellow: number }
  lines: DeviationRowDto[]
}

/** 步骤运行参数（POST /api/projects/:id/steps/:step/run） */
export interface StepRunRequest {
  model?: string | null
  force?: boolean
  /** ②：复用已有 vocals.wav，跳过 Demucs */
  reuseSeparation?: boolean
  /** ③：批大小 */
  batchSize?: number
  /** ④：连未确认的句子一起配 */
  includeUnconfirmed?: boolean
  /** ⑤：风格与模型 */
  styleId?: string
  consistency?: number
  keyframeModel?: string | null
  motionModel?: string | null
  onlyMissing?: boolean
  resetClips?: boolean
  concurrency?: number
  /** ⑥ */
  skipLipsync?: boolean
  name?: string | null
  resolution?: '1080p' | '720p'
  fps?: number
  bilingual?: boolean
}

export interface ConfirmRequest {
  force?: boolean
}

export interface ConfirmResponse {
  ok: boolean
  issues: GateIssue[]
}

export interface SidecarViewDto {
  online: boolean
  gpu: boolean
  device: string | null
  torch: string | null
  models: { demucs: boolean; musetalk: boolean }
  version: string
  reason: string | null
  mismatch: string | null
  port: number
  pythonPath: string
  bootstrapNote: string | null
}

export interface ModelCatalogDto {
  models: Array<{ id: string; label: string; kind: string; note: string; nightDiscount: boolean; timeAwareEligible: boolean; unavailable?: boolean; noLocalFallback?: boolean }>
  stageOptions: Record<string, string[]>
  styles: Array<{ id: string; label: string; desc: string }>
  presetVoices: Array<{ name: string; tags: readonly string[]; desc: string }>
  localModels: Array<{ key: string; label: string; usage: string; cost: string }>
  routes: ModelRouteDto[]
  /** Mock 模式下拉仍然可选，但调用不发真实请求 */
  mockMode: boolean
}

export interface SecretStateDto {
  available: boolean
  hasKey: boolean
  masked: string | null
}

export interface SettingsResponse {
  settings: SettingsDto
  routes: ModelRouteDto[]
  secret: SecretStateDto
}

export interface PickRequest {
  kind: 'video' | 'directory' | 'audio' | 'file'
  title?: string
}

export interface PickResponse {
  path: string | null
  paths: string[]
}

/** preload 经 contextBridge 暴露的唯一接口（SPEC-001 §7.5：仅目录选择与文件显示） */
export interface RendererBridgeApi {
  /** 主进程内嵌服务地址（dev 下渲染层在 vite 端口，需显式拿这个地址） */
  apiBase: string
  dev: boolean
  pick(kind: 'video' | 'directory' | 'audio' | 'file', opts?: { title?: string; multi?: boolean }): Promise<PickResponse>
  reveal(path: string): void
  info(): Promise<AppInfoDto>
  onNavigate(cb: (target: string) => void): () => void
}

export interface AppInfoDto {
  version: string
  electron: string
  platform: string
  appDataDir: string
  sidecarDir: string
  apiBase: string
}

export interface LogRequest {
  projectId: string
  name: string
  tail?: number
}

export interface LogResponse {
  file: string
  exists: boolean
  text: string
}

export interface LinePatchRequest {
  zhText?: string
  enText?: string
  enAlts?: string[]
  speakerId?: string | null
  shotId?: string | null
  startMs?: number
  endMs?: number
  overflowPolicy?: OverflowPolicy
  confirmStatus?: 'pending' | 'confirmed'
}

export interface ShotPatchRequest {
  startMs?: number
  endMs?: number
  sceneDesc?: string
  persons?: string[]
  acceptStatus?: ShotDto['acceptStatus']
  isPilot?: boolean
  styleId?: string
  source?: ShotDto['source']
}

export interface SpeakerPatchRequest {
  label?: string
  sampleStartMs?: number | null
  sampleEndMs?: number | null
  mappedVoiceId?: string | null
}

export interface VoiceCreateRequest {
  name: string
  samplePath?: string | null
  tags?: string[]
  sourceType?: 'preset' | 'cloned'
}

export interface SystemInfoDto {
  version: string
  electron: string
  platform: string
  mockMode: boolean
  hasApiKey: boolean
  appDataDir: string
  workspaceRoot: string
  exportDir: string
  serverPort: number
  ffmpeg: string
  modelsDir: string
}
