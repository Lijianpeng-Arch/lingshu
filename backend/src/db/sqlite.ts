/**
 * SQLite connection + migrations
 * Uses better-sqlite3. Migrates on creation; idempotent.
 */

import Database, { type Database as Db } from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 5;

const MIGRATIONS: Record<number, string[]> = {
  1: [
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS providers (
      name TEXT PRIMARY KEY, api_key TEXT NOT NULL, base_url TEXT NOT NULL,
      capabilities TEXT NOT NULL, models TEXT, probe_model TEXT,
      timeout_ms INTEGER NOT NULL DEFAULT 15000, extra_headers TEXT,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
    `CREATE TABLE IF NOT EXISTS long_term_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL, tags TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    // P2-7: LIKE 召回性能 — value 列加索引, 大表下避免全表扫
    `CREATE INDEX IF NOT EXISTS idx_long_term_memory_value ON long_term_memory(value)`,
  ],
  2: [
    // memories — 通用记忆 (短期对话/长期画像/任务相关/媒体历史)
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('short', 'long', 'profile', 'task', 'media')),
      key TEXT,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(scope, key)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags)`,

    // thoughts — 思考链 (借鉴白龙马 reasoning log)
    `CREATE TABLE IF NOT EXISTS thoughts (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('observation', 'inference', 'plan', 'question', 'decision')),
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES thoughts(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_thoughts_parent ON thoughts(parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts(created_at)`,

    // tasks — 任务记录
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'done', 'failed', 'cancelled')),
      parent_id TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`,

    // reminders — 提醒 (Phase E 主动行动用)
    `CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      trigger_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'fired', 'dismissed')),
      related_task_id TEXT,
      created_at INTEGER NOT NULL,
      fired_at INTEGER,
      FOREIGN KEY (related_task_id) REFERENCES tasks(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at, status)`,
  ],
  3: [
    // plans / plan_steps — Spec 2C-1 long task execution basics
    // 借 LangGraph checkpointer.py (SQLite plan persistence) + Manus task_planner.py
    `CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'running', 'paused', 'completed', 'aborted')),
      current_step_index INTEGER NOT NULL DEFAULT 0,
      replan_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
      result TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      retries INTEGER NOT NULL DEFAULT 0,
      acceptance TEXT,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, step_index)`,
  ],
  4: [
    // Spec 2D — persistent main loop tables.
    // user_reminders : NL-time reminders ("明天 9 点提醒我")
    // preferences    : persistent user preference store (ChatGPT-Memory style)
    //
    // Loaded from migration file to keep SQL out of the JS bundle.
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'migrations', '2026-07-16-add-reminders-prefs.sql'),
      'utf8',
    ),
  ],
  5: [
    // Spec 2C-2 — parallel sub-agent columns on plan_steps
    // parallel_group: 标记并行 step (同一 group 可同步 fork)
    // subtasks:       JSON-encoded SubAgentTask[] (parallel step 的子任务)
    // 借 LangGraph Send() (fan-out state) + Manus subagent_pool.py (sub-task pool)
    `ALTER TABLE plan_steps ADD COLUMN parallel_group TEXT`,
    `ALTER TABLE plan_steps ADD COLUMN subtasks TEXT`,
  ],
};

export function createSqlite(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const currentVersion = (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ?? 0;
  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const stmts = MIGRATIONS[v];
    if (!stmts) continue;
    db.transaction(() => {
      for (const sql of stmts) db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, Date.now());
    })();
  }
  return db;
}
