/** SQLite 单文件库（%APPDATA%/VariDub/app.db）——备份 = 复制文件（SPEC-001 §7.1） */
import BetterSqlite3 from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbFile, ensureDir } from '../paths'
import { migrate } from './migrations'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>
export type RawDb = BetterSqlite3.Database

let raw: RawDb | null = null
let typed: Db | null = null

/** forceFile：smoke 测试可传 ':memory:' 以外的临时路径 */
export function initDb(target?: string): Db {
  if (typed) return typed
  let file = target
  if (!file) {
    ensureDir(dbFile().replace(/[\\/]app\.db$/, ''))
    file = dbFile()
  }
  raw = BetterSqlite3(file)
  raw.pragma('busy_timeout = 5000')
  migrate(raw)
  typed = drizzle(raw, { schema })
  return typed
}

export function getDb(): Db {
  if (!typed) throw new Error('数据库未初始化')
  return typed
}

export function getRawDb(): RawDb {
  if (!raw) throw new Error('数据库未初始化')
  return raw
}

export function closeDb(): void {
  raw?.close()
  raw = null
  typed = null
}

/** 临时目录（smoke 测试用） */
export function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
