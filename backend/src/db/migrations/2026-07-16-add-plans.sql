-- Plan / PlanStep tables — Spec 2C-1 long task execution basics
--
-- 借鉴:
--   - LangGraph `checkpointer.py` (SQLite-based plan persistence)
--   - Manus `task_planner.py` (step-level status tracking)
--   - Devin `planner.py` (replan_count tracking)
--
-- 设计:
--   - plans        顶层 plan, 关联到一个 goal
--   - plan_steps   步骤, 通过 step_index 排序
--   - acceptance   是 JSON 数组 (每条 step 自己的小验收)

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'running', 'paused', 'completed', 'aborted')),
  current_step_index INTEGER NOT NULL DEFAULT 0,
  replan_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_steps (
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
);

CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, step_index);