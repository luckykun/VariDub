/**
 * SQLite schema（SPEC-001 §6 数据模型）。
 * drizzle 负责类型化查询；建表语句在 db/migrations.ts，启动时幂等执行。
 */
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const projectsTable = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sourceVideoPath: text('source_video_path').notNull(),
  durationMs: integer('duration_ms').notNull().default(0),
  width: integer('width').notNull().default(0),
  height: integer('height').notNull().default(0),
  status: text('status').notNull().default('in_progress'),
  currentStep: integer('current_step').notNull().default(1),
  /** Record<StepId, StepState> 的 JSON 快照 */
  stepState: text('step_state').notNull().default('{}'),
  thumbPath: text('thumb_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const shotsTable = sqliteTable('shots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  index: integer('index').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  sceneDesc: text('scene_desc').notNull().default(''),
  /** string[] JSON */
  persons: text('persons').notNull().default('[]'),
  thumbPath: text('thumb_path'),
  frame3dPath: text('frame3d_path'),
  clip3dPath: text('clip3d_path'),
  styleId: text('style_id').notNull().default('pixar'),
  consistencyScore: real('consistency_score'),
  acceptStatus: text('accept_status').notNull().default('pending'),
  isPilot: integer('is_pilot').notNull().default(0),
  source: text('source').notNull().default('vl'),
  error: text('error')
})

export const linesTable = sqliteTable('lines', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  shotId: text('shot_id'),
  speakerId: text('speaker_id'),
  index: integer('index').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  zhText: text('zh_text').notNull().default(''),
  enText: text('en_text').notNull().default(''),
  /** string[] JSON（评审决议 R3：备选 ×2） */
  enAlts: text('en_alts').notNull().default('[]'),
  slangFlag: integer('slang_flag').notNull().default(0),
  slangNote: text('slang_note'),
  overflowMs: integer('overflow_ms').notNull().default(0),
  overflowPolicy: text('overflow_policy').notNull().default('none'),
  confirmStatus: text('confirm_status').notNull().default('pending'),
  dubWavPath: text('dub_wav_path'),
  dubDurationMs: integer('dub_duration_ms'),
  similarity: real('similarity'),
  lipsyncStatus: text('lipsync_status').notNull().default('none'),
  lipsyncOffsetMs: integer('lipsync_offset_ms'),
  /** 锚点变更后下游产物失效（SPEC-001 §7.7-2） */
  stale: integer('stale').notNull().default(0)
})

export const speakersTable = sqliteTable('speakers', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  label: text('label').notNull(),
  sampleWavPath: text('sample_wav_path'),
  sampleStartMs: integer('sample_start_ms'),
  sampleEndMs: integer('sample_end_ms'),
  sampleQuality: text('sample_quality').notNull().default('ok'),
  sampleQualityNote: text('sample_quality_note'),
  /** 手动补选的样本区间（覆盖自动截取） */
  sampleOverride: integer('sample_override').notNull().default(0),
  mappedVoiceId: text('mapped_voice_id')
})

export const voicesTable = sqliteTable('voices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sourceType: text('source_type').notNull().default('cloned'),
  originProjectId: text('origin_project_id'),
  /** string[] JSON */
  tags: text('tags').notNull().default('[]'),
  samplePath: text('sample_path'),
  refCount: integer('ref_count').notNull().default(0),
  durationMs: integer('duration_ms'),
  /** TTS 侧音色 id（克隆返回） */
  vendorVoiceId: text('vendor_voice_id'),
  createdAt: text('created_at').notNull()
})

export const artifactsTable = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  step: integer('step').notNull(),
  kind: text('kind').notNull(),
  path: text('path').notNull().default(''),
  /** 云端异步任务 id，用于断点续跑避免重复计费（SPEC-001 §7.7-1） */
  taskId: text('task_id'),
  /** JSON 元信息（分镜 id、状态、url 等） */
  meta: text('meta').notNull().default('{}'),
  createdAt: text('created_at').notNull()
})

export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})
