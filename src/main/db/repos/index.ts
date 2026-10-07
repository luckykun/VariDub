/**
 * 仓储层（SPEC-001 §6 数据模型 ↔ DTO 映射）。
 * 行转 DTO 集中在本文件，路由层不接触列名，时间字段在 API 边界即格式化。
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { join } from 'node:path'
import type {
  ArtifactDto,
  ArtifactKind,
  ConfirmStatus,
  LineDto,
  OverflowPolicy,
  ProjectDto,
  ShotDto,
  SpeakerDto,
  StepId,
  StepState,
  VoiceDto,
  VoiceSourceType
} from '../../../shared/types'
import { STEP_IDS } from '../../../shared/types'
import { ensureProjectDir } from '../../paths'
import { newId } from '../../util/id'
import { getDb } from '../index'
import {
  artifactsTable,
  linesTable,
  projectsTable,
  shotsTable,
  speakersTable,
  voicesTable
} from '../schema'
import { getSetting } from './settings'

function toBool(v: number | null | undefined): boolean {
  return v === 1
}

function jsonArr<T>(text: string | null | undefined): T[] {
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as T[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function jsonObj<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function projectWorkspaceDir(projectId: string): string {
  return join(getSetting('storage.workspace_root'), projectId)
}

export function defaultStepStates(): Record<StepId, StepState> {
  const out = {} as Record<StepId, StepState>
  for (const s of STEP_IDS) out[s] = s === 1 ? 'ready' : 'locked'
  return out
}

/* ------------------------------------------------------------------ 项目 */

type ProjectRow = typeof projectsTable.$inferSelect

function projectStats(projectId: string): ProjectDto['stats'] {
  const db = getDb()
  const shotCount = db.select({ c: shotsTable.id }).from(shotsTable).where(eq(shotsTable.projectId, projectId)).all().length
  const lineRows = db.select().from(linesTable).where(eq(linesTable.projectId, projectId)).all()
  const speakerCount = db.select({ c: speakersTable.id }).from(speakersTable).where(eq(speakersTable.projectId, projectId)).all().length
  return {
    shotCount,
    lineCount: lineRows.length,
    speakerCount,
    dubDone: lineRows.filter((l) => !!l.dubWavPath).length,
    shot3dAccepted: db
      .select({ c: shotsTable.id })
      .from(shotsTable)
      .where(and(eq(shotsTable.projectId, projectId), eq(shotsTable.acceptStatus, 'accepted')))
      .all().length
  }
}

function toProject(row: ProjectRow): ProjectDto {
  const stepStates = { ...defaultStepStates(), ...jsonObj<Record<string, StepState>>(row.stepState, {}) }
  const typed = {} as Record<StepId, StepState>
  for (const s of STEP_IDS) typed[s] = stepStates[s] ?? 'locked'
  return {
    id: row.id,
    name: row.name,
    sourceVideoPath: row.sourceVideoPath,
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    status: row.status as ProjectDto['status'],
    currentStep: row.currentStep as StepId,
    stepStates: typed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workspaceDir: projectWorkspaceDir(row.id),
    thumbPath: row.thumbPath,
    stats: projectStats(row.id)
  }
}

export const Projects = {
  list(): ProjectDto[] {
    return getDb()
      .select()
      .from(projectsTable)
      .orderBy(desc(projectsTable.updatedAt))
      .all()
      .map(toProject)
  },
  get(id: string): ProjectDto | null {
    const row = getDb().select().from(projectsTable).where(eq(projectsTable.id, id)).get()
    return row ? toProject(row) : null
  },
  create(input: {
    name: string
    sourceVideoPath: string
    durationMs: number
    width: number
    height: number
  }): ProjectDto {
    const db = getDb()
    const id = newId('prj')
    const now = new Date().toISOString()
    db.insert(projectsTable)
      .values({
        id,
        name: input.name,
        sourceVideoPath: input.sourceVideoPath,
        durationMs: Math.round(input.durationMs),
        width: input.width,
        height: input.height,
        status: 'in_progress',
        currentStep: 1,
        stepState: JSON.stringify(defaultStepStates()),
        createdAt: now,
        updatedAt: now
      })
      .run()
    ensureProjectDir(getSetting('storage.workspace_root'), id)
    return toProject(db.select().from(projectsTable).where(eq(projectsTable.id, id)).get()!)
  },
  patch(id: string, patch: Partial<{ name: string; thumbPath: string | null; status: ProjectDto['status'] }>): void {
    getDb().update(projectsTable).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(projectsTable.id, id)).run()
  },
  setSteps(id: string, stepStates: Record<StepId, StepState>, currentStep: StepId): void {
    getDb()
      .update(projectsTable)
      .set({ stepState: JSON.stringify(stepStates), currentStep, updatedAt: new Date().toISOString() })
      .where(eq(projectsTable.id, id))
      .run()
  },
  touch(id: string): void {
    getDb().update(projectsTable).set({ updatedAt: new Date().toISOString() }).where(eq(projectsTable.id, id)).run()
  },
  remove(id: string): void {
    const db = getDb()
    db.delete(shotsTable).where(eq(shotsTable.projectId, id)).run()
    db.delete(linesTable).where(eq(linesTable.projectId, id)).run()
    db.delete(speakersTable).where(eq(speakersTable.projectId, id)).run()
    db.delete(artifactsTable).where(eq(artifactsTable.projectId, id)).run()
    db.delete(projectsTable).where(eq(projectsTable.id, id)).run()
  }
}

/* ------------------------------------------------------------------ 分镜 */

type ShotRow = typeof shotsTable.$inferSelect

function toShot(row: ShotRow): ShotDto {
  return {
    id: row.id,
    projectId: row.projectId,
    index: row.index,
    startMs: row.startMs,
    endMs: row.endMs,
    sceneDesc: row.sceneDesc,
    persons: jsonArr<string>(row.persons),
    thumbPath: row.thumbPath,
    frame3dPath: row.frame3dPath,
    clip3dPath: row.clip3dPath,
    styleId: row.styleId,
    consistencyScore: row.consistencyScore,
    acceptStatus: row.acceptStatus as ShotDto['acceptStatus'],
    source: row.source as ShotDto['source'],
    error: row.error,
    isPilot: toBool(row.isPilot)
  }
}

export const Shots = {
  list(projectId: string): ShotDto[] {
    return getDb()
      .select()
      .from(shotsTable)
      .where(eq(shotsTable.projectId, projectId))
      .orderBy(asc(shotsTable.index))
      .all()
      .map(toShot)
  },
  get(id: string): ShotDto | null {
    const row = getDb().select().from(shotsTable).where(eq(shotsTable.id, id)).get()
    return row ? toShot(row) : null
  },
  replaceAll(projectId: string, shots: Array<Omit<ShotDto, 'projectId'>>): void {
    const db = getDb()
    db.delete(shotsTable).where(eq(shotsTable.projectId, projectId)).run()
    if (shots.length === 0) return
    db.insert(shotsTable)
      .values(
        shots.map((s, i) => ({
          id: s.id || newId('sht'),
          projectId,
          index: s.index ?? i,
          startMs: Math.round(s.startMs),
          endMs: Math.round(s.endMs),
          sceneDesc: s.sceneDesc,
          persons: JSON.stringify(s.persons ?? []),
          thumbPath: s.thumbPath ?? null,
          frame3dPath: s.frame3dPath ?? null,
          clip3dPath: s.clip3dPath ?? null,
          styleId: s.styleId || 'pixar',
          consistencyScore: s.consistencyScore ?? null,
          acceptStatus: s.acceptStatus || 'pending',
          isPilot: s.isPilot ? 1 : 0,
          source: s.source ?? 'vl',
          error: s.error ?? null
        }))
      )
      .run()
  },
  patch(id: string, patch: Partial<ShotDto>): void {
    getDb().update(shotsTable).set(shotPatchToRow(patch)).where(eq(shotsTable.id, id)).run()
  },
  patchMany(ids: string[], patch: Partial<ShotDto>): void {
    if (ids.length === 0) return
    getDb().update(shotsTable).set(shotPatchToRow(patch)).where(inArray(shotsTable.id, ids)).run()
  },
  count(projectId: string): number {
    return getDb().select({ c: shotsTable.id }).from(shotsTable).where(eq(shotsTable.projectId, projectId)).all().length
  },
  /** 批量改状态（如：把 failed 重置为 queued 以便重跑） */
  setStatusFor(projectId: string, from: ShotDto['acceptStatus'][], to: ShotDto['acceptStatus']): number {
    if (from.length === 0) return 0
    const rows = getDb()
      .select({ id: shotsTable.id })
      .from(shotsTable)
      .where(and(eq(shotsTable.projectId, projectId), inArray(shotsTable.acceptStatus, from)))
      .all()
    Shots.setAcceptStatus(rows.map((r) => r.id), to)
    return rows.length
  },
  setAcceptStatus(ids: string[], status: ShotDto['acceptStatus']): void {
    if (ids.length === 0) return
    getDb().update(shotsTable).set({ acceptStatus: status }).where(inArray(shotsTable.id, ids)).run()
  },
  /** 重置全部渲染产物（换风格/换模型重跑用） */
  resetRender(projectId: string): void {
    getDb()
      .update(shotsTable)
      .set({ acceptStatus: 'pending', clip3dPath: null, frame3dPath: null, consistencyScore: null, error: null })
      .where(eq(shotsTable.projectId, projectId))
      .run()
  }
}

function shotPatchToRow(patch: Partial<ShotDto>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === 'persons') out.persons = JSON.stringify(value ?? [])
    else if (key === 'isPilot') out.isPilot = value ? 1 : 0
    else out[key] = value
  }
  return out
}

function linePatchToRow(patch: Partial<LineDto>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === 'enAlts') out.enAlts = JSON.stringify(value ?? [])
    else if (key === 'anchorStale') out.stale = value ? 1 : 0
    else if (key === 'slangFlag') out.slangFlag = value ? 1 : 0
    else out[key] = value
  }
  return out
}

/* ------------------------------------------------------------------ 句 */

type LineRow = typeof linesTable.$inferSelect

function toLine(row: LineRow): LineDto {
  return {
    id: row.id,
    projectId: row.projectId,
    shotId: row.shotId,
    speakerId: row.speakerId,
    index: row.index,
    startMs: row.startMs,
    endMs: row.endMs,
    zhText: row.zhText,
    enText: row.enText,
    enAlts: jsonArr<string>(row.enAlts),
    slangFlag: toBool(row.slangFlag),
    slangNote: row.slangNote,
    overflowMs: row.overflowMs,
    overflowPolicy: row.overflowPolicy as OverflowPolicy,
    confirmStatus: row.confirmStatus as ConfirmStatus,
    dubWavPath: row.dubWavPath,
    dubDurationMs: row.dubDurationMs,
    similarity: row.similarity,
    lipsyncStatus: row.lipsyncStatus as LineDto['lipsyncStatus'],
    lipsyncOffsetMs: row.lipsyncOffsetMs,
    anchorStale: toBool(row.stale)
  }
}

export const Lines = {
  list(projectId: string): LineDto[] {
    return getDb()
      .select()
      .from(linesTable)
      .where(eq(linesTable.projectId, projectId))
      .orderBy(asc(linesTable.index))
      .all()
      .map(toLine)
  },
  get(id: string): LineDto | null {
    const row = getDb().select().from(linesTable).where(eq(linesTable.id, id)).get()
    return row ? toLine(row) : null
  },
  replaceAll(projectId: string, lines: Array<Partial<LineDto> & { startMs: number; endMs: number }>): void {
    const db = getDb()
    db.delete(linesTable).where(eq(linesTable.projectId, projectId)).run()
    if (lines.length === 0) return
    db.insert(linesTable)
      .values(
        lines.map((l, i) => ({
          id: l.id || newId('lin'),
          projectId,
          shotId: l.shotId ?? null,
          speakerId: l.speakerId ?? null,
          index: l.index ?? i,
          startMs: Math.round(l.startMs),
          endMs: Math.round(l.endMs),
          zhText: l.zhText ?? '',
          enText: l.enText ?? '',
          enAlts: JSON.stringify(l.enAlts ?? []),
          slangFlag: l.slangFlag ? 1 : 0,
          slangNote: l.slangNote ?? null,
          overflowMs: Math.round(l.overflowMs ?? 0),
          overflowPolicy: l.overflowPolicy ?? 'none',
          confirmStatus: l.confirmStatus ?? 'pending',
          dubWavPath: l.dubWavPath ?? null,
          dubDurationMs: l.dubDurationMs ?? null,
          similarity: l.similarity ?? null,
          lipsyncStatus: l.lipsyncStatus ?? 'none',
          lipsyncOffsetMs: l.lipsyncOffsetMs ?? null,
          stale: l.anchorStale ? 1 : 0
        }))
      )
      .run()
  },
  patch(id: string, patch: Partial<LineDto>): void {
    getDb().update(linesTable).set(linePatchToRow(patch)).where(eq(linesTable.id, id)).run()
  },
  setMany(ids: string[], patch: Partial<LineDto>): void {
    if (ids.length === 0) return
    getDb().update(linesTable).set(linePatchToRow(patch)).where(inArray(linesTable.id, ids)).run()
  },
  markDownstreamStale(projectId: string): void {
    getDb().update(linesTable).set({ stale: 1 }).where(eq(linesTable.projectId, projectId)).run()
  }
}

/* ----------------------------------------------------------------- 说话人 */

type SpeakerRow = typeof speakersTable.$inferSelect

function toSpeaker(row: SpeakerRow): SpeakerDto {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    sampleWavPath: row.sampleWavPath,
    sampleStartMs: row.sampleStartMs,
    sampleEndMs: row.sampleEndMs,
    sampleQuality: row.sampleQuality as SpeakerDto['sampleQuality'],
    sampleQualityNote: row.sampleQualityNote,
    mappedVoiceId: row.mappedVoiceId
  }
}

export const Speakers = {
  list(projectId: string): SpeakerDto[] {
    return getDb()
      .select()
      .from(speakersTable)
      .where(eq(speakersTable.projectId, projectId))
      .orderBy(asc(speakersTable.label))
      .all()
      .map(toSpeaker)
  },
  get(id: string): SpeakerDto | null {
    const row = getDb().select().from(speakersTable).where(eq(speakersTable.id, id)).get()
    return row ? toSpeaker(row) : null
  },
  create(projectId: string, label: string): SpeakerDto {
    const db = getDb()
    const id = newId('spk')
    db.insert(speakersTable).values({ id, projectId, label }).run()
    return toSpeaker(db.select().from(speakersTable).where(eq(speakersTable.id, id)).get()!)
  },
  replaceAll(projectId: string, speakers: Array<Partial<SpeakerDto> & { label: string }>): void {
    const db = getDb()
    db.delete(speakersTable).where(eq(speakersTable.projectId, projectId)).run()
    if (speakers.length === 0) return
    db.insert(speakersTable)
      .values(
        speakers.map((s) => ({
          id: s.id || newId('spk'),
          projectId,
          label: s.label,
          sampleWavPath: s.sampleWavPath ?? null,
          sampleStartMs: s.sampleStartMs ?? null,
          sampleEndMs: s.sampleEndMs ?? null,
          sampleQuality: s.sampleQuality ?? 'ok',
          sampleQualityNote: s.sampleQualityNote ?? null,
          sampleOverride: s.sampleStartMs !== null && s.sampleEndMs !== null ? 1 : 0,
          mappedVoiceId: s.mappedVoiceId ?? null
        }))
      )
      .run()
  },
  patch(id: string, patch: Partial<SpeakerDto>): void {
    getDb().update(speakersTable).set(speakerPatchToRow(patch)).where(eq(speakersTable.id, id)).run()
  }
}

function speakerPatchToRow(patch: Partial<SpeakerDto>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/* ------------------------------------------------------------------ 音色 */

type VoiceRow = typeof voicesTable.$inferSelect

function toVoice(row: VoiceRow, projectName?: string | null): VoiceDto {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType as VoiceSourceType,
    originProjectId: row.originProjectId,
    originProjectName: projectName ?? null,
    tags: jsonArr<string>(row.tags),
    samplePath: row.samplePath,
    refCount: row.refCount,
    durationMs: row.durationMs,
    vendorVoiceId: row.vendorVoiceId,
    createdAt: row.createdAt
  }
}

export const Voices = {
  list(): VoiceDto[] {
    const db = getDb()
    const rows = db.select().from(voicesTable).orderBy(asc(voicesTable.createdAt)).all()
    const projects = db.select().from(projectsTable).all()
    const nameById = new Map(projects.map((p) => [p.id, p.name]))
    return rows.map((r) => toVoice(r, r.originProjectId ? nameById.get(r.originProjectId) ?? null : null))
  },
  get(id: string): VoiceDto | null {
    const row = getDb().select().from(voicesTable).where(eq(voicesTable.id, id)).get()
    return row ? toVoice(row) : null
  },
  create(input: {
    name: string
    sourceType: VoiceSourceType
    originProjectId?: string | null
    tags?: string[]
    samplePath?: string | null
    durationMs?: number | null
    vendorVoiceId?: string | null
  }): VoiceDto {
    const db = getDb()
    const id = newId('voc')
    db.insert(voicesTable)
      .values({
        id,
        name: input.name,
        sourceType: input.sourceType,
        originProjectId: input.originProjectId ?? null,
        tags: JSON.stringify(input.tags ?? []),
        samplePath: input.samplePath ?? null,
        durationMs: input.durationMs ?? null,
        vendorVoiceId: input.vendorVoiceId ?? null,
        refCount: 0,
        createdAt: new Date().toISOString()
      })
      .run()
    return toVoice(db.select().from(voicesTable).where(eq(voicesTable.id, id)).get()!)
  },
  patch(id: string, patch: Partial<VoiceDto> & { vendorVoiceId?: string | null }): void {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      out[key] = key === 'tags' ? JSON.stringify(value ?? []) : value
    }
    getDb().update(voicesTable).set(out).where(eq(voicesTable.id, id)).run()
  },
  bumpRef(projectId: string, voiceId: string | null): void {
    if (!voiceId) return
    const row = getDb().select().from(voicesTable).where(eq(voicesTable.id, voiceId)).get()
    if (!row) return
    getDb().update(voicesTable).set({ refCount: row.refCount + 1 }).where(eq(voicesTable.id, voiceId)).run()
    void projectId
  },
  remove(id: string): void {
    getDb().delete(voicesTable).where(eq(voicesTable.id, id)).run()
  },
  byIds(ids: string[]): VoiceDto[] {
    if (ids.length === 0) return []
    return getDb()
      .select()
      .from(voicesTable)
      .where(inArray(voicesTable.id, ids))
      .all()
      .map((r) => toVoice(r))
  }
}

/* ---------------------------------------------------------------- 检查点 */

type ArtifactRow = typeof artifactsTable.$inferSelect

function toArtifact(row: ArtifactRow): ArtifactDto {
  return {
    id: row.id,
    projectId: row.projectId,
    step: row.step as StepId,
    kind: row.kind as ArtifactKind,
    path: row.path,
    taskId: row.taskId,
    meta: jsonObj<Record<string, unknown>>(row.meta, {}),
    createdAt: row.createdAt
  }
}

export const Artifacts = {
  list(projectId: string, step?: StepId): ArtifactDto[] {
    const db = getDb()
    const rows = step
      ? db.select().from(artifactsTable).where(and(eq(artifactsTable.projectId, projectId), eq(artifactsTable.step, step))).all()
      : db.select().from(artifactsTable).where(eq(artifactsTable.projectId, projectId)).all()
    return rows.map(toArtifact)
  },
  find(projectId: string, kind: ArtifactKind, taskId?: string): ArtifactDto | null {
    const rows = getDb()
      .select()
      .from(artifactsTable)
      .where(and(eq(artifactsTable.projectId, projectId), eq(artifactsTable.kind, kind)))
      .all()
      .map(toArtifact)
    if (taskId) return rows.find((r) => r.taskId === taskId) ?? null
    return rows[0] ?? null
  },
  /** 未完成云端任务（重启后先查这些 task 再决定是否重提交，SPEC-001 §7.7-1） */
  pendingCloudTasks(): ArtifactDto[] {
    return getDb()
      .select()
      .from(artifactsTable)
      .where(inArray(artifactsTable.kind, ['cloud_task' as ArtifactKind]))
      .all()
      .map(toArtifact)
      .filter((a) => a.taskId !== null && (a.meta.status === 'submitted' || a.meta.status === 'running'))
  },
  upsert(input: {
    projectId: string
    step: StepId
    kind: ArtifactKind
    path?: string
    taskId?: string | null
    meta?: Record<string, unknown>
    match?: (a: ArtifactDto) => boolean
  }): ArtifactDto {
    const db = getDb()
    const existing = db
      .select()
      .from(artifactsTable)
      .where(and(eq(artifactsTable.projectId, input.projectId), eq(artifactsTable.kind, input.kind)))
      .all()
      .map(toArtifact)
      .find((a) => (input.match ? input.match(a) : input.taskId ? a.taskId === input.taskId : true))
    if (existing) {
      db.update(artifactsTable)
        .set({
          path: input.path ?? existing.path,
          taskId: input.taskId ?? existing.taskId,
          meta: JSON.stringify({ ...existing.meta, ...(input.meta ?? {}) })
        })
        .where(eq(artifactsTable.id, existing.id))
        .run()
      return { ...existing, path: input.path ?? existing.path, taskId: input.taskId ?? existing.taskId }
    }
    const id = newId('art')
    db.insert(artifactsTable)
      .values({
        id,
        projectId: input.projectId,
        step: input.step,
        kind: input.kind,
        path: input.path ?? '',
        taskId: input.taskId ?? null,
        meta: JSON.stringify(input.meta ?? {}),
        createdAt: new Date().toISOString()
      })
      .run()
    const row = db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).get()!
    return toArtifact(row)
  },
  removeByKind(projectId: string, kind: ArtifactKind): void {
    getDb()
      .delete(artifactsTable)
      .where(and(eq(artifactsTable.projectId, projectId), eq(artifactsTable.kind, kind)))
      .run()
  }
}
