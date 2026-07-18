/**
 * Replan 决策 — 灵枢 V2 Spec 2C-1
 *
 * 决策矩阵 (来自 spec §2.4):
 *   - 失败步骤 retries >= MAX_RETRIES (3)        → 全 plan replan
 *   - progress < 0.5 + blocker                    → 全 plan replan
 *   - progress >= 0.5 + 单步失败                  → 单步 replan (只重写这一步)
 *   - replan_count >= MAX_REPLAN (3)              → aborted (用户接力)
 *
 * 借鉴:
 *   - Devin planner.py (replan 决策)
 *   - Hermes convergence.ts (进度收敛判定)
 *
 * 设计:
 *   - 纯函数 shouldReplan() — 输入 plan + 失败 step, 输出 ReplanDecision
 *   - caller (runner) 根据决策决定: 单步 replan / 全 plan replan / aborted
 *   - 单步 replan 不会增 replan_count (只换描述); 全 plan replan 会增 1
 */

import type { Plan, PlanStep } from '../plan/types.js';
import { planProgress } from '../plan/types.js';

export const MAX_RETRIES = 3;
export const MAX_REPLANS = 3;
export const REPLAN_PROGRESS_THRESHOLD = 0.5;

export type ReplanKind = 'full' | 'single-step' | 'abort';

export interface ReplanDecision {
  kind: ReplanKind;
  /** 触发原因 (人类可读, 写日志用) */
  reason: string;
  /** 当 kind='single-step' 时: 哪一步需要重写 (失败的那步) */
  stepId?: string;
}

/**
 * 决策函数 — 纯函数, 易于测试.
 *
 * @param plan 当前 plan
 * @param failedStep 刚失败的 step
 * @param userAborted 用户是否在过程中点了"停止目标"
 */
export function shouldReplan(
  plan: Plan,
  failedStep: PlanStep,
  userAborted = false,
): ReplanDecision {
  // 用户中断 → 直接 aborted, 不再 replan
  if (userAborted) {
    return { kind: 'abort', reason: 'user aborted' };
  }

  // 已超最大 replan 次数 → aborted
  if (plan.replan_count >= MAX_REPLANS) {
    return { kind: 'abort', reason: `replan_count >= ${MAX_REPLANS}` };
  }

  // 单步 retries 超上限 → 全 plan replan
  if (failedStep.retries >= MAX_RETRIES) {
    return {
      kind: 'full',
      reason: `step "${failedStep.description}" retries >= ${MAX_RETRIES}`,
    };
  }

  // 进度 < 50% 且单步失败 → 全 plan replan (可能整体方向错)
  const progress = planProgress(plan);
  if (progress < REPLAN_PROGRESS_THRESHOLD) {
    return {
      kind: 'full',
      reason: `progress ${(progress * 100).toFixed(0)}% < ${REPLAN_PROGRESS_THRESHOLD * 100}%, single-step failure indicates wrong direction`,
    };
  }

  // 进度 >= 50% 且单步失败 → 单步 replan (只重写这一步, 已完成的保留)
  return {
    kind: 'single-step',
    reason: `progress ${(progress * 100).toFixed(0)}% >= ${REPLAN_PROGRESS_THRESHOLD * 100}%, retry just the failed step`,
    stepId: failedStep.id,
  };
}

/**
 * 执行 replan 后, 生成一个新的 Plan (保留已完成步骤, 替换未完成/失败的步骤).
 *
 * @param oldPlan 当前 plan
 * @param newStepDescriptions 新步骤的 description 列表 (caller 通过 LLM 生成)
 * @returns 新 Plan (id 不同, status='draft', replan_count+1)
 *
 * 行为:
 *   - 复制所有 completed/skipped 步骤 → 新 plan
 *   - 失败步骤 (及之后 pending 的步骤) → 用 newStepDescriptions 替换
 *   - replan_count += 1
 *   - 新 plan id 不同, 但 goal_id 相同 (一个 Goal 可多次 replan)
 */
import { newPlanId, newStepId } from '../plan/parser.js';

export function rebuildPlan(
  oldPlan: Plan,
  newStepDescriptions: string[],
): Plan {
  const keptSteps = oldPlan.steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  );

  const newSteps: PlanStep[] = newStepDescriptions.map((desc) => ({
    id: newStepId(),
    description: desc,
    status: 'pending',
    retries: 0,
  }));

  const now = Date.now();
  return {
    id: newPlanId(),
    goal_id: oldPlan.goal_id,
    steps: [...keptSteps, ...newSteps],
    created_at: now,
    updated_at: now,
    status: 'draft',
    current_step_index: 0,
    replan_count: oldPlan.replan_count + 1,
  };
}

/**
 * 单步 replan: 仅替换失败那一步的 description, 保留其他步骤 + 已完成状态.
 *
 * @returns 更新后的 steps 数组 (不会写入 db, 由 caller 持久化)
 */
export function rebuildSingleStep(
  plan: Plan,
  failedStepId: string,
  newDescription: string,
): PlanStep[] {
  return plan.steps.map((s) =>
    s.id === failedStepId
      ? {
          ...s,
          description: newDescription,
          status: 'pending',
          retries: 0,
          result: undefined,
          started_at: undefined,
          completed_at: undefined,
        }
      : s,
  );
}