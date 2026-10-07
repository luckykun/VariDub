/**
 * 检查点落盘与续跑索引（SPEC-001 §1.1-P5、§7.1）。
 * 每步产物 = JSON 检查点 + 媒体文件；Artifact 表提供「已完成」索引，重跑时跳过。
 */
import { existsSync } from 'node:fs'
import type { ArtifactKind, LineDto, ShotDto, StepId } from '../../shared/types'
import { Artifacts } from '../db/repos'
import { ensureParent } from '../logger'
import { readJson, writeJson } from '../util/json'
import { projectPaths } from './paths'

export function writeShotsCheckpoint(projectId: string, shots: ShotDto[]): string {
  const p = projectPaths(projectId)
  ensureParent(p.shotsJson)
  writeJson(p.shotsJson, {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    shots: shots.map((s) => ({
      index: s.index,
      start_ms: s.startMs,
      end_ms: s.endMs,
      scene_desc: s.sceneDesc,
      persons: s.persons,
      thumb: s.thumbPath,
      source: s.source
    }))
  })
  track(projectId, 1, 'shots_json', p.shotsJson, { count: shots.length })
  return p.shotsJson
}

export function writeAsrCheckpoint(projectId: string, data: unknown): string {
  const p = projectPaths(projectId)
  writeJson(p.asrJson, data)
  track(projectId, 2, 'asr_json', p.asrJson, {})
  return p.asrJson
}

export function writeTranslationCheckpoint(projectId: string, lines: LineDto[]): string {
  const p = projectPaths(projectId)
  writeJson(p.translationJson, {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    lines: lines.map((l) => ({
      id: l.id,
      index: l.index,
      shot_id: l.shotId,
      speaker_id: l.speakerId,
      start_ms: l.startMs,
      end_ms: l.endMs,
      zh: l.zhText,
      en: l.enText,
      en_alts: l.enAlts,
      slang: l.slangFlag ? l.slangNote : null,
      overflow_ms: l.overflowMs,
      overflow_policy: l.overflowPolicy,
      confirmed: l.confirmStatus === 'confirmed'
    }))
  })
  track(projectId, 3, 'translation_json', p.translationJson, { count: lines.length })
  return p.translationJson
}

export interface DubManifestRow {
  line_id: string
  index: number
  speaker: string | null
  wav: string | null
  target_ms: number
  actual_ms: number | null
  deviation_ms: number | null
  similarity: number | null
  similarity_method: string | null
  voice_source: string | null
  status: string
}

export function writeDubCheckpoint(projectId: string, rows: DubManifestRow[]): string {
  const p = projectPaths(projectId)
  writeJson(p.dubManifest, { version: 1, projectId, updatedAt: new Date().toISOString(), lines: rows })
  track(projectId, 4, 'dub_manifest', p.dubManifest, { count: rows.length })
  return p.dubManifest
}

export interface RenderManifestRow {
  shot_id: string
  index: number
  keyframe: string | null
  clip: string | null
  consistency: number | null
  status: string
  task_id: string | null
  error: string | null
}

export function writeRenderCheckpoint(projectId: string, rows: RenderManifestRow[]): string {
  const p = projectPaths(projectId)
  writeJson(p.renderManifest, { version: 1, projectId, updatedAt: new Date().toISOString(), shots: rows })
  track(projectId, 5, 'render_manifest', p.renderManifest, { count: rows.length })
  return p.renderManifest
}

export function track(projectId: string, step: StepId, kind: ArtifactKind, path: string, meta: Record<string, unknown>): void {
  Artifacts.upsert({ projectId, step, kind, path, meta })
}

/** 已完成项索引：重跑时跳过（断点续跑 + 不重复计费） */
export function doneKeys(projectId: string, kind: ArtifactKind): Set<string> {
  const set = new Set<string>()
  for (const a of Artifacts.list(projectId)) {
    if (a.kind !== kind) continue
    const key = a.meta.key
    if (typeof key === 'string') set.add(key)
    else if (a.path && existsSync(a.path)) set.add(a.path)
  }
  return set
}

export function markDone(projectId: string, step: StepId, kind: ArtifactKind, key: string, path: string, meta: Record<string, unknown> = {}): void {
  Artifacts.upsert({ projectId, step, kind, path, meta: { key, ...meta }, match: (a) => a.meta.key === key })
}

export function clearDone(projectId: string, kind: ArtifactKind): void {
  Artifacts.removeByKind(projectId, kind)
}

export function readCheckpoint<T>(file: string, fallback: T): T {
  return readJson<T>(file, fallback)
}
