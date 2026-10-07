/**
 * 内嵌幂等建表语句（替代 drizzle-kit 生成物，避免打包期 codegen 依赖）。
 * 结构必须与 db/schema.ts 一致；后续加列在此追加新版本并递增 DB_VERSION。
 * index 是 SQLite 关键字，列名必须加双引号（drizzle 生成的查询也是带引号的）。
 */
import type { Database } from 'better-sqlite3'

export const DB_VERSION = 1

const V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_video_path TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress',
  current_step INTEGER NOT NULL DEFAULT 1,
  step_state TEXT NOT NULL DEFAULT '{}',
  thumb_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  "index" INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  scene_desc TEXT NOT NULL DEFAULT '',
  persons TEXT NOT NULL DEFAULT '[]',
  thumb_path TEXT,
  frame3d_path TEXT,
  clip3d_path TEXT,
  style_id TEXT NOT NULL DEFAULT 'pixar',
  consistency_score REAL,
  accept_status TEXT NOT NULL DEFAULT 'pending',
  is_pilot INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'vl',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_shots_project ON shots (project_id, "index");
CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  shot_id TEXT,
  speaker_id TEXT,
  "index" INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  zh_text TEXT NOT NULL DEFAULT '',
  en_text TEXT NOT NULL DEFAULT '',
  en_alts TEXT NOT NULL DEFAULT '[]',
  slang_flag INTEGER NOT NULL DEFAULT 0,
  slang_note TEXT,
  overflow_ms INTEGER NOT NULL DEFAULT 0,
  overflow_policy TEXT NOT NULL DEFAULT 'none',
  confirm_status TEXT NOT NULL DEFAULT 'pending',
  dub_wav_path TEXT,
  dub_duration_ms INTEGER,
  similarity REAL,
  lipsync_status TEXT NOT NULL DEFAULT 'none',
  lipsync_offset_ms INTEGER,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lines_project ON lines (project_id, "index");
CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  sample_wav_path TEXT,
  sample_start_ms INTEGER,
  sample_end_ms INTEGER,
  sample_quality TEXT NOT NULL DEFAULT 'ok',
  sample_quality_note TEXT,
  sample_override INTEGER NOT NULL DEFAULT 0,
  mapped_voice_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_speakers_project ON speakers (project_id);
CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'cloned',
  origin_project_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  sample_path TEXT,
  ref_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  vendor_voice_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts (project_id, step, kind);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export function migrate(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  // 用 PRAGMA user_version 记账：建表之前就能读，不会陷入「先查 settings 表才能建 settings 表」
  const version = Number(db.pragma('user_version', { simple: true }))
  const current = Number.isFinite(version) ? version : 0
  if (current < 1) db.exec(V1)
  if (current < DB_VERSION) db.pragma(`user_version = ${DB_VERSION}`)
}
