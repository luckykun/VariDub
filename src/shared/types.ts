/**
 * 渲染层 ↔ 本地服务层共用的 DTO 定义（单一真源）。
 * 渲染层禁止直接访问文件系统 / 外网，所有数据经此契约流转（SPEC-001 §7.5）。
 */

export type StepId = 1 | 2 | 3 | 4 | 5 | 6

export const STEP_IDS: StepId[] = [1, 2, 3, 4, 5, 6]

export const STEP_LABELS: Record<StepId, string> = {
  1: '视频解析',
  2: '人声分离·识别',
  3: '中→英翻译',
  4: '音色克隆配音',
  5: '3D 画面重绘',
  6: '口型对齐·导出'
}

/** 单步状态机 */
export type StepState = 'locked' | 'ready' | 'running' | 'review' | 'confirmed' | 'error'

export type ProjectStatus = 'draft' | 'in_progress' | 'done'

export interface ProjectDto {
  id: string
  name: string
  sourceVideoPath: string
  durationMs: number
  width: number
  height: number
  status: ProjectStatus
  currentStep: StepId
  stepStates: Record<StepId, StepState>
  createdAt: string
  updatedAt: string
  /** 检查点目录 */
  workspaceDir: string
  /** 统计信息（列表卡片用） */
  stats: {
    shotCount: number
    lineCount: number
    speakerCount: number
    dubDone: number
    shot3dAccepted: number
  }
  thumbPath: string | null
}

export interface ShotDto {
  id: string
  projectId: string
  index: number
  startMs: number
  endMs: number
  sceneDesc: string
  persons: string[]
  thumbPath: string | null
  frame3dPath: string | null
  clip3dPath: string | null
  styleId: string
  consistencyScore: number | null
  acceptStatus: 'pending' | 'accepted' | 'rejected' | 'rendering' | 'queued' | 'failed'
  /** 分镜来源：云端视觉模型 / 本地 PySceneDetect 兜底 / 人工切分 */
  source: 'vl' | 'pyscenedetect' | 'manual'
  /** 渲染失败原因 */
  error: string | null
  /** 试跑基准分镜 */
  isPilot: boolean
}

export type OverflowPolicy = 'none' | 'compress' | 'freeze'
export type ConfirmStatus = 'pending' | 'confirmed'

export interface LineDto {
  id: string
  projectId: string
  shotId: string | null
  speakerId: string | null
  index: number
  startMs: number
  endMs: number
  zhText: string
  enText: string
  enAlts: string[]
  slangFlag: boolean
  slangNote: string | null
  /** 译文时长超出原句时长 = 超支 */
  overflowMs: number
  overflowPolicy: OverflowPolicy
  confirmStatus: ConfirmStatus
  dubWavPath: string | null
  dubDurationMs: number | null
  similarity: number | null
  lipsyncStatus: 'none' | 'done' | 'stale' | 'failed'
  lipsyncOffsetMs: number | null
  anchorStale: boolean
}

export interface SpeakerDto {
  id: string
  projectId: string
  label: string
  sampleWavPath: string | null
  sampleStartMs: number | null
  sampleEndMs: number | null
  /** ok | short | noisy */
  sampleQuality: 'ok' | 'short' | 'noisy'
  sampleQualityNote: string | null
  mappedVoiceId: string | null
}

export type VoiceSourceType = 'preset' | 'cloned'

export interface VoiceDto {
  id: string
  name: string
  sourceType: VoiceSourceType
  originProjectId: string | null
  originProjectName: string | null
  tags: string[]
  samplePath: string | null
  refCount: number
  durationMs: number | null
  /** 云端音色复刻返回的 voice id（预置音色为空，TTS 侧用名字） */
  vendorVoiceId: string | null
  createdAt: string
}

export type ArtifactKind =
  | 'shots_json'
  | 'asr_json'
  | 'translation_json'
  | 'vocals_wav'
  | 'bgm_wav'
  | 'voice_sample'
  | 'dub_wav'
  | 'dub_manifest'
  | 'shot3d_clip'
  | 'keyframe'
  | 'render_manifest'
  | 'final_mp4'
  | 'final_srt'
  | 'cloud_task'
  | 'thumbnail'

export interface ArtifactDto {
  id: string
  projectId: string
  step: StepId
  kind: ArtifactKind
  path: string
  taskId: string | null
  meta: Record<string, unknown>
  createdAt: string
}

/** 时段感知路由（SPEC-001 §5.4） */
export type RouteStage = 'shot_analysis' | 'translate'

export interface ResolvedModel {
  stage: RouteStage
  model: string
  /** 夜间 4 折是否生效 */
  discountActive: boolean
  /** UI 角标文案 */
  badge: string
  /** auto = 时段路由；否则为手动指定的模型 id */
  mode: 'auto' | 'manual'
  window: { start: string; end: string; inWindow: boolean }
}

export interface ModelRouteDto {
  stage: RouteStage
  label: string
  auto: boolean
  override: string | null
  candidates: string[]
  effective: ResolvedModel
}

export interface SettingsDto {
  api: {
    keyMasked: string | null
    hasKey: boolean
    baseUrl: string
    mockMode: boolean
  }
  routes: {
    timeAware: boolean
    discountWindow: string
    stage1: string
    stage2: string
    stage3: string
    stage4: string
    stage5Keyframe: string
    stage5Motion: string
  }
  storage: {
    workspaceRoot: string
    exportDir: string
    freeBytesC: number | null
    freeBytesD: number | null
  }
  style: {
    preset: 'pixar' | 'anime' | 'claymation'
    faceConsistency: number
    renderConcurrency: number
  }
  translate: {
    styleInstruction: string
    altsCount: number
    globalOverflowPolicy: OverflowPolicy
  }
  tts: {
    speed: number
    pitch: number
    emotion: number
  }
  export: {
    resolution: '1080p' | '720p'
    fps: number
    bilingualSrt: boolean
  }
  sidecar: {
    autoStart: boolean
    pythonPath: string
    port: number
  }
  ui: {
    copyrightNoticeDismissed: boolean
  }
}

export interface PrecheckItem {
  key: 'duration' | 'audio' | 'visual'
  label: string
  pass: boolean
  detail: string
  blocking: boolean
}

export interface PrecheckResult {
  filePath: string
  fileName: string
  durationMs: number
  width: number
  height: number
  hasAudio: boolean
  items: PrecheckItem[]
  ok: boolean
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobDto {
  id: string
  projectId: string
  step: StepId
  name: string
  state: JobState
  progress: number
  message: string | null
  error: string | null
  logPath: string | null
  startedAt: string
  finishedAt: string | null
}

/** SSE 事件负载 */
export type ServerEvent =
  | { type: 'job:update'; job: JobDto }
  | { type: 'step:update'; projectId: string; stepStates: Record<StepId, StepState>; currentStep: StepId }
  | { type: 'project:update'; projectId: string }
  | { type: 'shots:update'; projectId: string }
  | { type: 'lines:update'; projectId: string }
  | { type: 'speakers:update'; projectId: string }
  | { type: 'voices:update' }
  | { type: 'settings:update' }
  | { type: 'gpu:occupy'; jobId: string | null; label: string | null }
  | { type: 'sidecar:status'; online: boolean; gpu: boolean; reason: string | null }
  | { type: 'log'; projectId: string; line: string }

/** API 统一响应包装 */
export interface ApiError {
  error: string
  detail?: string
}
