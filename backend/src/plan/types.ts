/**
 * Plan / PlanStep 数据结构 — 灵枢 V2 长任务执行基础
 *
 * Spec 2C-1: 让灵枢有 plan、能续跑
 * Spec 2C-2: 让 PlanStep 支持并行 (parallel_group + subtasks)
 *
 * 借鉴:
 *   - Manus `task_planner.py` (Plan / PlanStep / StepStatus 类型)
 *   - Devin `planner.py` (replan_count 字段)
 *   - LangGraph `checkpointer.py` (序列化支持, 便于 SQLite 持久化)
 *   - LangGraph `Send()` primitive (subtasks fan-out)
 *
 * 设计:
 *   - Plan 关联一个 Goal (一个 Goal 可以对应多个 Plan, 但同时只跑一个)
 *   - PlanStep 通过 step_index 排序 (0, 1, 2, ...)
 *   - StepStatus: pending → running → completed/failed, 可跳到 skipped
 *   - Plan status: draft → running → paused/completed/aborted
 *   - replan_count 累计 (上限 3, 超过则 aborted)
 *   - acceptance 是字符串数组 (每条 step 自己的小验收)
 *   - parallel_group: 标记该 step 是并行的, 同一 group 的 steps 同步触发 sub-agents
 *   - subtasks: parallel step 派生的子任务 (Spec 2C-2)
 */

import type { SubAgentTask } from '../subagent/types.js';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  description: string;
  status: StepStatus;
  result?: string;
  started_at?: number;
  completed_at?: number;
  retries: number;
  acceptance?: string[];
  /** Spec 2C-2: 标记并行组 (同组的 step 由 PlanRunner 并行 fork sub-agent) */
  parallel_group?: string;
  /** Spec 2C-2: parallel step 的子任务 (每个 subtask → 一个 sub-agent) */
  subtasks?: SubAgentTask[];
}

export type PlanStatus = 'draft' | 'running' | 'paused' | 'completed' | 'aborted';

export interface Plan {
  id: string;
  goal_id: string;
  steps: PlanStep[];
  created_at: number;
  updated_at: number;
  status: PlanStatus;
  current_step_index: number;
  replan_count: number;
}

/**
 * 计算 Plan 完成进度 (0.0 - 1.0).
 * 借鉴 Hermes convergence.ts: 布尔收敛判定.
 * - 已 completed 的步骤 / 总步骤
 * - 空 plan 视为 1.0 (无步骤 = 无要求)
 */
export function planProgress(plan: Plan): number {
  if (plan.steps.length === 0) return 1.0;
  const completed = plan.steps.filter(s => s.status === 'completed').length;
  return completed / plan.steps.length;
}

/**
 * 判断 Plan 是否已完成 (所有步骤都 completed/skipped).
 */
export function isPlanComplete(plan: Plan): boolean {
  return plan.steps.length > 0 && plan.steps.every(s => s.status === 'completed' || s.status === 'skipped');
}