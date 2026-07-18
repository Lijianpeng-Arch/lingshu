/**
 * Plan Parser — 从 Goal + acceptance 推导一个初始 Plan (粗骨架)
 * 灵枢 V2 Spec 2C-1
 *
 * 借鉴:
 *   - Manus task_planner.py (heuristic decompose from goal text)
 *   - Devin planner.py (acceptance → step mapping)
 *
 * 注意: 这个 parser 只生成"粗骨架" — 真正的 LLM-based 拆解在 planner/index.ts.
 * 这里的目的是给一个 fallback, 当 LLM 不可用时能继续工作.
 *
 * 启发式:
 *   - 1 条 acceptance → 1 个 step (1:1 mapping)
 *   - 0 条 acceptance → 1 个 step "执行目标"
 *   - 步骤 id 自动生成 (step_xxxxxxxxxxxx)
 *   - 步骤 description 取 acceptance 原文 (或 "执行目标" 作为兜底)
 */

import { randomUUID } from 'node:crypto';
import type { Plan, PlanStep } from './types.js';
import type { Goal } from '../agent/goal.js';

export function newPlanId(): string {
  return `plan_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function newStepId(): string {
  return `step_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * 从 Goal 推导一个粗骨架 Plan.
 *
 * 行为:
 *   - 每个 acceptance criteria → 1 个 step (description = criteria 原文)
 *   - 没有 acceptance → 1 个 step "执行目标: <statement>"
 *
 * 所有 step 初始 status='pending', retries=0, 没有 acceptance/started_at/completed_at.
 */
export function parsePlanFromGoal(goal: Goal, planId?: string): Plan {
  const now = Date.now();
  const id = planId ?? newPlanId();
  let steps: PlanStep[];

  if (goal.acceptance.length === 0) {
    steps = [{
      id: newStepId(),
      description: `执行目标: ${goal.statement}`,
      status: 'pending',
      retries: 0,
    }];
  } else {
    steps = goal.acceptance.map((c) => ({
      id: newStepId(),
      description: c.text,
      status: 'pending',
      retries: 0,
      acceptance: [c.text],  // step 自己的小验收 = 原 acceptance 文本
    }));
  }

  return {
    id,
    goal_id: goal.id,
    steps,
    created_at: now,
    updated_at: now,
    status: 'draft',
    current_step_index: 0,
    replan_count: 0,
  };
}