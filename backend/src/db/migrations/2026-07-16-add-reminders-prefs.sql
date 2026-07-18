-- Spec 2D — Persistent Main Loop tables.
--
-- Two new tables:
--   - user_reminders : NL-typed reminders ("明天 9 点提醒我开会") parsed to timestamp.
--                     NOTE: spec calls this "reminders", but migration v2 already has
--                     a `reminders` table (title/content/related_task_id). We use
--                     `user_reminders` to avoid conflict — same semantics, separate store.
--   - preferences    : persistent user preferences (key/value JSON + confidence/source).
--
-- Borrowed from:
--   - macOS Reminders / Apple Reminders DB schema (timestamp-indexed, status state machine)
--   - ChatGPT Memory (per-key store with confidence score)
--   - 白龙马 preference store (JSON blob per key)

CREATE TABLE IF NOT EXISTS user_reminders (
  id TEXT PRIMARY KEY,
  user_input TEXT NOT NULL,         -- 原文: "明天 9 点提醒我开会"
  message TEXT NOT NULL,            -- 提取出的提醒内容: "开会"
  trigger_at INTEGER NOT NULL,      -- Unix-ms
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'fired', 'cancelled')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_reminders_pending
  ON user_reminders(trigger_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,              -- JSON encoded
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL
    CHECK(source IN ('explicit', 'inferred')),
  updated_at INTEGER NOT NULL
);
