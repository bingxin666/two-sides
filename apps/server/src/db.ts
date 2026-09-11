/**
 * SQLite 初始化 + 幂等迁移（bun:sqlite）
 *
 * 键设计照 docs/03 §7：
 *  - hot_questions/analyses 以 (date, qid) 为主键，date 是东八区日期键
 *  - jobs 的 UNIQUE(date, qid) 就是并发锁（§6.3）：谁 INSERT 成功谁启动 runner
 *
 * 迁移策略：CREATE TABLE IF NOT EXISTS + ensureColumn（缺列补列），
 * 全部可重复执行，用 PRAGMA user_version 记录当前版本。
 */

import { Database } from 'bun:sqlite'
import { env } from './env'
import { log } from './log'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let _db: Database | null = null

const SCHEMA_VERSION = 1

const DDL = `
CREATE TABLE IF NOT EXISTS hot_questions (
  date       TEXT NOT NULL,
  qid        TEXT NOT NULL,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (date, qid)
);

CREATE TABLE IF NOT EXISTS analyses (
  date          TEXT NOT NULL,
  qid           TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','generating','ready','failed')),
  data          TEXT,
  error_code    TEXT,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (date, qid)
);

CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL,
  qid               TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','generating','ready','failed')),
  stage             TEXT NOT NULL DEFAULT 'extract',
  stage_ratio       REAL NOT NULL DEFAULT 0,
  sample_count      INTEGER NOT NULL DEFAULT 0,
  judgments_done    INTEGER NOT NULL DEFAULT 0,
  judgments_total   INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  error_message     TEXT,
  retryable         INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  detail            TEXT,
  owner             TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (date, qid)
);

CREATE INDEX IF NOT EXISTS idx_analyses_date_status ON analyses (date, status);
CREATE INDEX IF NOT EXISTS idx_jobs_date_status ON jobs (date, status);
`

/** 缺列补列：ALTER TABLE ADD COLUMN 在列已存在时会报错，故先探测再补 */
function ensureColumn(db: Database, table: string, column: string, decl: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  log.info('db.migrate.addColumn', { table, column })
}

function migrate(db: Database): void {
  db.exec(DDL)

  // 未来加列的写法示例（幂等）：
  // ensureColumn(db, 'jobs', 'attempts', 'INTEGER NOT NULL DEFAULT 0')

  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  const current = row?.user_version ?? 0
  if (current < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
}

export function getDb(): Database {
  if (_db) return _db
  const file = resolve(process.cwd(), env.DB_PATH)
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  // WAL：读不阻塞写，多个读请求能在生成进行时照常返回进度
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  _db = db
  log.info('db.ready', { path: env.DB_PATH, schemaVersion: SCHEMA_VERSION })
  return db
}

/** 测试/脚本口径：关闭连接（生产进程不调用） */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
