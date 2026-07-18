/**
 * PlanStore — 灵枢 V2 Plan 持久化 (SQLite)
 * Spec 2C-1 long task execution basics
 *
 * 借鉴:
 *   - LangGraph `checkpointer.py` (SQLite plan persistence)
 *   - 灵枢自身 `memory/repo.ts` (row ↔ object mappers)
 *
 * 设计:
 *   - Plan ↔ plan_steps (1:N, 通过 plan_id 关联)
 *   - acceptance 字段在 SQLite 里存为 JSON, 读取时反序列化
 *   - createPlan 整批插入, updateStep 单步更新
 *   - replacePlanSteps 用于 replan (删旧步 + 插新步, 同事务)
 */

import type { Database as Db } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Plan, PlanStep, PlanStatus, StepStatus } from './types.js';

// ── Row 类型 (snake_case, SQLite 直出) ─────────────────

interface PlanRow {
  id: string;
  goal_id: string;
  status: string;
  current_step_index: number;
  replan_count: number;
  created_at: number;
  updated_at: number;
}

interface PlanStepRow {
  id: string;
  plan_id: string;
  step_index: number;
  description: string;
  status: string;
  result: string | null;
  started_at: number | null;
  completed_at: number | null;
  retries: number;
  acceptance: string | null;
  // Spec 2C-2: parallel group + subtasks (subtasks stored as JSON)
  parallel_group: string | null;
  subtasks: string | null;
}

// ── Row ↔ Object mappers ────────────────────────────────

function rowToPlan(row: PlanRow, steps: PlanStep[]): Plan {
  return {
    id: row.id,
    goal_id: row.goal_id,
    steps,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status as PlanStatus,
    current_step_index: row.current_step_index,
    replan_count: row.replan_count,
  };
}

function rowToStep(row: PlanStepRow, index: number): PlanStep {
  // Spec 2C-2: 反序列化 parallel_group + subtasks
  let parallel_group: string | undefined;
  let subtasks: PlanStep['subtasks'];
  if (row.parallel_group) parallel_group = row.parallel_group;
  if (row.subtasks) {
    try {
      subtasks = JSON.parse(row.subtasks);
    } catch {
      subtasks = undefined;
    }
  }
  return {
    id: row.id,
    description: row.description,
    status: row.status as StepStatus,
    result: row.result ?? undefined,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
    retries: row.retries,
    acceptance: row.acceptance ? (JSON.parse(row.acceptance) as string[]) : undefined,
    parallel_group,
    subtasks,
    // 暴露 step_index 方便排序修复 (理论上已 ORDER BY, 这里兜底)
    ...(row.step_index !== index ? {} : {}),
  };
}

// ── Repo 接口 ──────────────────────────────────────────

export interface PlanRepo {
  createPlan(plan: Plan): Plan;
  getPlan(planId: string): Plan | null;
  listPlansByGoal(goalId: string): Plan[];
  updatePlanStatus(planId: string, status: PlanStatus): void;
  /** 更新当前步骤索引 (runner 推进用) */
  updateCurrentStepIndex(planId: string, index: number): void;
  updateStep(stepId: string, update: Partial<PlanStep>): void;
  incrementStepRetries(stepId: string): number;
  incrementReplanCount(planId: string): number;
  /** 删旧步 + 插新步, replan 专用 (同事务) */
  replacePlanSteps(planId: string, newSteps: PlanStep[]): void;
  /** 列出 plan 全部步骤 (内部用) */
  getSteps(planId: string): PlanStep[];
}

// ── 实现 ──────────────────────────────────────────────

export function createPlanStore(db: Db): PlanRepo {
  // Prepared statements (compiled once, reused)
  const insertPlan = db.prepare(`INSERT INTO plans
    (id, goal_id, status, current_step_index, replan_count, created_at, updated_at)
    VALUES (@id, @goal_id, @status, @current_step_index, @replan_count, @created_at, @updated_at)`);
  const insertStep = db.prepare(`INSERT INTO plan_steps
    (id, plan_id, step_index, description, status, result, started_at, completed_at, retries, acceptance, parallel_group, subtasks)
    VALUES (@id, @plan_id, @step_index, @description, @status, @result, @started_at, @completed_at, @retries, @acceptance, @parallel_group, @subtasks)`);
  const getPlanRow = db.prepare(`SELECT * FROM plans WHERE id = ?`);
  const getSteps = db.prepare(`SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_index ASC`);
  const listPlansByGoal = db.prepare(`
    SELECT p.*, s.id AS step_id, s.step_index, s.description AS step_description,
      s.status AS step_status, s.result AS step_result, s.started_at AS step_started_at,
      s.completed_at AS step_completed_at, s.retries AS step_retries,
      s.acceptance AS step_acceptance, s.parallel_group AS step_parallel_group,
      s.subtasks AS step_subtasks
    FROM plans p
    LEFT JOIN plan_steps s ON s.plan_id = p.id
    WHERE p.goal_id = ?
    ORDER BY p.created_at DESC, s.step_index ASC`);
  const updatePlanStatus = db.prepare(`UPDATE plans SET status = ?, updated_at = ? WHERE id = ?`);
  const updateCurrentStepIndex = db.prepare(`UPDATE plans SET current_step_index = ?, updated_at = ? WHERE id = ?`);
  const updateStep = db.prepare(`UPDATE plan_steps
    SET description = ?, status = ?, result = ?, started_at = ?, completed_at = ?, retries = ?, acceptance = ?, parallel_group = ?, subtasks = ?
    WHERE id = ?`);
  const getStep = db.prepare(`SELECT * FROM plan_steps WHERE id = ?`);
  const incrementRetries = db.prepare(`UPDATE plan_steps SET retries = retries + 1 WHERE id = ? RETURNING retries`);
  const incrementReplan = db.prepare(`UPDATE plans SET replan_count = replan_count + 1, updated_at = ? WHERE id = ? RETURNING replan_count`);
  const deleteSteps = db.prepare(`DELETE FROM plan_steps WHERE plan_id = ?`);

  return {
    createPlan(plan) {
      const insertAll = db.transaction((p: Plan) => {
        insertPlan.run({
          id: p.id,
          goal_id: p.goal_id,
          status: p.status,
          current_step_index: p.current_step_index,
          replan_count: p.replan_count,
          created_at: p.created_at,
          updated_at: p.updated_at,
        });
        for (let i = 0; i < p.steps.length; i++) {
          const s = p.steps[i]!;
          insertStep.run({
            id: s.id,
            plan_id: p.id,
            step_index: i,
            description: s.description,
            status: s.status,
            result: s.result ?? null,
            started_at: s.started_at ?? null,
            completed_at: s.completed_at ?? null,
            retries: s.retries,
            acceptance: s.acceptance ? JSON.stringify(s.acceptance) : null,
            parallel_group: s.parallel_group ?? null,
            subtasks: s.subtasks ? JSON.stringify(s.subtasks) : null,
          });
        }
      });
      insertAll(plan);
      const loaded = getPlanRow.get(plan.id) as PlanRow | undefined;
      const steps = (getSteps.all(plan.id) as PlanStepRow[]).map((r, i) => rowToStep(r, i));
      return rowToPlan(loaded!, steps);
    },

    getPlan(planId) {
      const row = getPlanRow.get(planId) as PlanRow | undefined;
      if (!row) return null;
      const steps = (getSteps.all(planId) as PlanStepRow[]).map((r, i) => rowToStep(r, i));
      return rowToPlan(row, steps);
    },

    listPlansByGoal(goalId) {
      const rows = listPlansByGoal.all(goalId) as Array<PlanRow & {
        step_id: string | null;
        step_index: number | null;
        step_description: string | null;
        step_status: string | null;
        step_result: string | null;
        step_started_at: number | null;
        step_completed_at: number | null;
        step_retries: number | null;
        step_acceptance: string | null;
        step_parallel_group: string | null;
        step_subtasks: string | null;
      }>;
      const plans = new Map<string, { row: PlanRow; steps: PlanStep[] }>();
      for (const row of rows) {
        let plan = plans.get(row.id);
        if (!plan) {
          plan = { row, steps: [] };
          plans.set(row.id, plan);
        }
        if (row.step_id !== null) {
          plan.steps.push(rowToStep({
            id: row.step_id,
            plan_id: row.id,
            step_index: row.step_index!,
            description: row.step_description!,
            status: row.step_status!,
            result: row.step_result,
            started_at: row.step_started_at,
            completed_at: row.step_completed_at,
            retries: row.step_retries!,
            acceptance: row.step_acceptance,
            parallel_group: row.step_parallel_group,
            subtasks: row.step_subtasks,
          }, row.step_index!));
        }
      }
      return [...plans.values()].map(({ row, steps }) => rowToPlan(row, steps));
    },

    updatePlanStatus(planId, status) {
      updatePlanStatus.run(status, Date.now(), planId);
    },

    updateCurrentStepIndex(planId, index) {
      updateCurrentStepIndex.run(index, Date.now(), planId);
    },

    updateStep(stepId, update) {
      // 读出当前 step 用于合并 (只更新传入字段)
      const current = getStep.get(stepId) as PlanStepRow | undefined;
      if (!current) return;
      updateStep.run(
        update.description ?? current.description,
        update.status ?? current.status,
        update.result ?? current.result,
        update.started_at ?? current.started_at,
        update.completed_at ?? current.completed_at,
        update.retries ?? current.retries,
        update.acceptance ? JSON.stringify(update.acceptance) : current.acceptance,
        // Spec 2C-2: parallel_group + subtasks (现有值兜底)
        update.parallel_group !== undefined ? update.parallel_group : current.parallel_group,
        update.subtasks !== undefined ? JSON.stringify(update.subtasks) : current.subtasks,
        stepId,
      );
    },

    incrementStepRetries(stepId) {
      const r = incrementRetries.get(stepId) as { retries: number } | undefined;
      return r?.retries ?? 0;
    },

    incrementReplanCount(planId) {
      const r = incrementReplan.get(Date.now(), planId) as { replan_count: number } | undefined;
      return r?.replan_count ?? 0;
    },

    replacePlanSteps(planId, newSteps) {
      const tx = db.transaction(() => {
        deleteSteps.run(planId);
        for (let i = 0; i < newSteps.length; i++) {
          const s = newSteps[i]!;
          insertStep.run({
            id: s.id,
            plan_id: planId,
            step_index: i,
            description: s.description,
            status: s.status,
            result: s.result ?? null,
            started_at: s.started_at ?? null,
            completed_at: s.completed_at ?? null,
            retries: s.retries,
            acceptance: s.acceptance ? JSON.stringify(s.acceptance) : null,
            parallel_group: s.parallel_group ?? null,
            subtasks: s.subtasks ? JSON.stringify(s.subtasks) : null,
          });
        }
      });
      tx();
    },

    getSteps(planId) {
      return (getSteps.all(planId) as PlanStepRow[]).map((r, i) => rowToStep(r, i));
    },
  };
}

/**
 * 工具函数: 生成新 step id (暴露给 planner 用)
 */
export function newStepId(): string {
  return `step_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}