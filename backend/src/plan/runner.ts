/**
 * PlanRunner — 灵枢 V2 长任务执行核心
 * Spec 2C-1 + 2C-2 (parallel sub-agent)
 *
 * 借鉴:
 *   - LangGraph checkpointer.py (断点续跑, loadPlan)
 *   - OpenHands controller.py (step retries, error escalation)
 *   - Manus task_planner.py (顺序执行, status tracking)
 *   - LangGraph Send() primitive (2C-2: parallel fan-out)
 *   - Manus subagent_pool.py (2C-2: 并行 sub-agent pool)
 *
 * 核心循环:
 *   for each step in plan where status === 'pending':
 *     step.status = 'running', persist, emit plan.step_started
 *     try ctx.runStep(step, goal) → result  [串行]
 *     或 try runSubAgents(step.subtasks) → result  [并行, Spec 2C-2]
 *     step.status = 'completed', persist, emit plan.step_completed
 *     on err: retries++, persist, decide replan
 *
 * 事件流 (返回给 caller 用于广播):
 *   plan.created → plan.step_started → plan.step_completed → ... → plan.completed
 *   失败时: plan.replanned (新 plan) 或 status=aborted
 *
 * 断点续跑:
 *   loadPlan(plan_id) → 把 'running' 步骤改回 'pending' (用户中断), 返回 plan
 *   resumePlan(plan_id, ctx, llm) → loadPlan + runPlan
 */

import type { LLMProvider } from '../agent/verifier.js';
import type { Plan, PlanStep, StepStatus } from './types.js';
import { isPlanComplete } from './types.js';
import type { PlanRepo } from './store.js';
import { shouldReplan, rebuildSingleStep, MAX_RETRIES } from '../planner/replan.js';
import { runSubAgents } from '../subagent/runner.js';
import type { SubAgentExecutor } from '../subagent/types.js';

// ── Runner 接口 (与 ctx/llm 解耦) ────────────────────

/**
 * Runner Context — 执行一步 + 检查 abort
 * 借 OpenHands controller.py: 抽象 executor 接口
 */
export interface RunnerContext {
  /** 执行一步: 返回该步骤的结果字符串 (串行 step) */
  runStep(step: PlanStep, plan: Plan): Promise<string>;
  /** 用户是否中断 (例如点"停止目标"按钮) */
  isAborted(): boolean;
  /**
   * Spec 2C-2: sub-agent executor (用于 parallel step).
   * 如果不提供, parallel step 仍能跑 (但行为是 echo executor, 测试场景).
   * 真实场景由 main-loop 注入 (子 agent 也是 LLM loop).
   */
  subAgentExecutor?: SubAgentExecutor;
}

/** 步骤事件 (runner → caller, 由 main-loop 转发到 awareness) */
export type PlanEvent =
  | { kind: 'plan.step_started'; plan_id: string; step_id: string; step_index: number }
  | { kind: 'plan.step_completed'; plan_id: string; step_id: string; result: string }
  | { kind: 'plan.replanned'; plan_id: string; new_steps: PlanStep[] }
  | { kind: 'plan.completed'; plan_id: string; duration_ms: number };

/** Runner 配置 */
export interface RunnerConfig {
  /** 重试上限 (默认 3, 借 OpenHands) */
  maxRetries?: number;
  /** 单步 LLM 提示词 (用于 verifier-style 小验收) — 留空表示不做 sub-verification */
  verifyStep?: (step: PlanStep, result: string, llm: LLMProvider) => Promise<boolean>;
}

const DEFAULT_CONFIG: Required<Pick<RunnerConfig, 'maxRetries'>> & RunnerConfig = {
  maxRetries: MAX_RETRIES,
};

/** Runner 接口 */
export interface PlanRunner {
  /** 执行整个 plan, 返回最终状态 (completed/aborted) + 期间所有事件 */
  runPlan(plan: Plan, ctx: RunnerContext, llm: LLMProvider, events: (e: PlanEvent) => void): Promise<Plan>;
  /** 断点续跑: 加载 plan + 把 running 步骤改回 pending + 跑 */
  resumePlan(planId: string, ctx: RunnerContext, llm: LLMProvider, events: (e: PlanEvent) => void): Promise<Plan | null>;
  /** 把 plan 持久化时遇到 running 步骤改回 pending (用于断点续跑前) */
  prepareForResume(plan: Plan): Plan;
}

// ── 工厂 ────────────────────────────────────────────

export function createPlanRunner(repo: PlanRepo): PlanRunner {
  const config = DEFAULT_CONFIG;
  // H10: prevent two concurrent runPlan/resumePlan calls for the same plan
  // from racing on the same plan.steps state. The Promise here is awaited
  // by every caller; when the in-flight call finishes, the entry is removed.
  const inflightPlans = new Map<string, Promise<unknown>>();

  /**
   * 准备 plan 状态: 把 running 步骤改回 pending (用户中断标记)
   * 已完成的步骤保留 completed 状态.
   */
  function prepareForResume(plan: Plan): Plan {
    const fixed = plan.steps.map((s) =>
      s.status === 'running'
        ? { ...s, status: 'pending' as StepStatus, started_at: undefined }
        : s,
    );
    return { ...plan, steps: fixed, status: 'paused' as const, updated_at: Date.now() };
  }

  /**
   * 执行单个步骤: 运行 → 设置结果 → 持久化 → 触发事件
   *
   * Spec 2C-2: 如果 step 有 subtasks → 走并行 sub-agent (forkSubAgent).
   * 否则走原 ctx.runStep 路径 (向后兼容).
   */
  async function executeStep(
    plan: Plan,
    stepIndex: number,
    ctx: RunnerContext,
    llm: LLMProvider,
    events: (e: PlanEvent) => void,
  ): Promise<{ plan: Plan; step: PlanStep; failed: boolean }> {
    const step = plan.steps[stepIndex]!;
    const now = Date.now();

    // 标记 running + 持久化
    const runningStep: PlanStep = { ...step, status: 'running', started_at: now, retries: step.retries };
    repo.updateStep(step.id, { status: 'running', started_at: now });
    events({ kind: 'plan.step_started', plan_id: plan.id, step_id: step.id, step_index: stepIndex });
    repo.updateCurrentStepIndex(plan.id, stepIndex);

    const updatedPlan: Plan = {
      ...plan,
      current_step_index: stepIndex,
      steps: plan.steps.map((s, i) => (i === stepIndex ? runningStep : s)),
    };

    try {
      // Spec 2C-2: parallel 分支 — step 有 subtasks 时 fork N 个 sub-agent 并行
      const result = await runStepOrParallel(runningStep, updatedPlan, ctx);
      const completedAt = Date.now();

      // 标记 completed + 持久化
      repo.updateStep(step.id, { status: 'completed', result, completed_at: completedAt });
      events({
        kind: 'plan.step_completed',
        plan_id: plan.id,
        step_id: step.id,
        result,
      });

      const completedStep: PlanStep = { ...runningStep, status: 'completed', result, completed_at: completedAt };
      const finalPlan: Plan = {
        ...updatedPlan,
        steps: updatedPlan.steps.map((s, i) => (i === stepIndex ? completedStep : s)),
      };
      return { plan: finalPlan, step: completedStep, failed: false };
    } catch (err) {
      // 失败: retries++, 持久化失败状态
      const newRetries = repo.incrementStepRetries(step.id);
      repo.updateStep(step.id, { status: 'failed' });
      const failedStep: PlanStep = { ...runningStep, status: 'failed', retries: newRetries };
      const finalPlan: Plan = {
        ...updatedPlan,
        steps: updatedPlan.steps.map((s, i) => (i === stepIndex ? failedStep : s)),
      };
      // 记录错误但不 throw (caller 决定 replan)
      console.error(`[plan-runner] step "${step.description}" failed (retry ${newRetries}):`, err instanceof Error ? err.message : String(err));
      return { plan: finalPlan, step: failedStep, failed: true };
    }
  }

  /**
   * Spec 2C-2: 决定走串行还是并行.
   *
   * - step.subtasks 存在且非空 → 走 runSubAgents (并行 fan-out)
   * - 否则 → 走 ctx.runStep (原有逻辑)
   *
   * 并行分支要求 ctx.subAgentExecutor 必须提供 (否则 fallback 到 echo).
   */
  async function runStepOrParallel(
    step: PlanStep,
    plan: Plan,
    ctx: RunnerContext,
  ): Promise<string> {
    if (!step.subtasks || step.subtasks.length === 0) {
      // 串行: 原路径
      return await ctx.runStep(step, plan);
    }
    // 并行: fork sub-agents
    // 注入 fallback executor 避免 ctx.subAgentExecutor 缺失
    const executor = ctx.subAgentExecutor ?? defaultEchoFallback;
    const outcome = await runSubAgents(step.subtasks, {
      executor,
      isAborted: ctx.isAborted,
    } as any);
    // Spec 2C-2: 整体失败 (任何 sub-agent 失败) → 抛出, 让 runner 走 retry/replan
    if (!outcome.ok) {
      throw new Error(`parallel step failed: ${outcome.results.filter(r => !r.ok).length}/${outcome.results.length} sub-agents failed`);
    }
    return outcome.merged_output;
  }

  /**
   * Replan: 单步 replan (不增 replan_count) — 走 LLM 重新生成 description, 然后替换
   * 全 plan replan 需要 caller 介入 (因为要重新 LLM 拆解), 这里只处理 single-step
   */
  async function handleSingleStepReplan(
    plan: Plan,
    failedStep: PlanStep,
    llm: LLMProvider,
    events: (e: PlanEvent) => void,
  ): Promise<PlanStep[]> {
    // 防御: 不到单步 replan 条件
    const newSteps = rebuildSingleStep(plan, failedStep.id, failedStep.description);
    // 简单做法: 保留原 description (caller 可在外面调 LLM 重新生成)
    // 这里把 step 的 retries 重置为 0, 让它从 pending 重新跑
    events({ kind: 'plan.replanned', plan_id: plan.id, new_steps: newSteps });
    return newSteps;
  }

  async function runPlanImpl(
    plan: Plan,
    ctx: RunnerContext,
    llm: LLMProvider,
    events: (e: PlanEvent) => void,
  ): Promise<Plan> {
    const startMs = Date.now();
    // 标记 running
    repo.updatePlanStatus(plan.id, 'running');

    let currentPlan = plan;

    for (let i = 0; i < currentPlan.steps.length; i++) {
      // 用户中断检查
      if (ctx.isAborted()) {
        // 把 running 步骤改回 pending, 持久化
        const fixed = prepareForResume(currentPlan);
        repo.updateStep(fixed.steps[i]!.id, { status: 'pending', started_at: undefined });
        repo.updatePlanStatus(currentPlan.id, 'paused');
        return { ...fixed, status: 'aborted' };
      }

      const step = currentPlan.steps[i]!;
      // 跳过已 completed/skipped 的步骤 (断点续跑场景)
      if (step.status !== 'pending') continue;

      const { plan: afterStep, step: finalStep, failed } = await executeStep(
        currentPlan,
        i,
        ctx,
        llm,
        events,
      );
      currentPlan = afterStep;

      if (failed) {
        // 决策: replan?
        const decision = shouldReplan(currentPlan, finalStep, ctx.isAborted());
        if (decision.kind === 'abort') {
          repo.updatePlanStatus(currentPlan.id, 'aborted');
          return { ...currentPlan, status: 'aborted' };
        }
        if (decision.kind === 'single-step') {
          // 单步 replan: 替换该 step description, 重新跑这一步 (不增加 replan_count)
          const newSteps = await handleSingleStepReplan(currentPlan, finalStep, llm, events);
          currentPlan = { ...currentPlan, steps: newSteps };
          i--;  // 重新尝试该步 (i++ 后回到 i)
          continue;
        }
        // decision.kind === 'full' — 单步 runner 暂不直接处理, 标记 aborted
        // (全 plan replan 由 caller 介入, 这里只通知 caller)
        repo.updatePlanStatus(currentPlan.id, 'aborted');
        // 触发 plan.replanned 事件, 让 caller 拿到失败 plan 后做 LLM 拆解
        events({ kind: 'plan.replanned', plan_id: currentPlan.id, new_steps: [] });
        return { ...currentPlan, status: 'aborted' };
      }
    }

    // 全 plan 跑完
    if (isPlanComplete(currentPlan)) {
      const duration = Date.now() - startMs;
      repo.updatePlanStatus(currentPlan.id, 'completed');
      events({ kind: 'plan.completed', plan_id: currentPlan.id, duration_ms: duration });
      return { ...currentPlan, status: 'completed' };
    }

    return currentPlan;
  }

  function runPlan(
    plan: Plan,
    ctx: RunnerContext,
    llm: LLMProvider,
    events: (e: PlanEvent) => void,
  ): Promise<Plan> {
    // H10: dedup concurrent runs of the same plan. If another run is already
    // in flight, return the same Promise so callers wait for the same
    // execution instead of double-running the steps.
    const existing = inflightPlans.get(plan.id);
    if (existing) return existing as Promise<Plan>;
    const p = runPlanImpl(plan, ctx, llm, events);
    inflightPlans.set(plan.id, p);
    p.finally(() => {
      if (inflightPlans.get(plan.id) === p) inflightPlans.delete(plan.id);
    });
    return p;
  }

  async function resumePlan(
    planId: string,
    ctx: RunnerContext,
    llm: LLMProvider,
    events: (e: PlanEvent) => void,
  ): Promise<Plan | null> {
    const loaded = repo.getPlan(planId);
    if (!loaded) return null;
    if (loaded.status === 'completed') return loaded;

    // 准备: running → pending
    const prepared = prepareForResume(loaded);
    // 持久化准备结果
    repo.replacePlanSteps(prepared.id, prepared.steps);
    repo.updatePlanStatus(prepared.id, 'paused');

    return await runPlan(prepared, ctx, llm, events);
  }

  return {
    runPlan,
    resumePlan,
    prepareForResume,
  };
}

/**
 * Spec 2C-2: fallback executor — 当 ctx.subAgentExecutor 没注入时使用.
 * 把 prompt 直接当 output 返回 (用于测试 + 没有 LLM 时的退化路径).
 *
 * 真实生产场景由 main-loop 注入 LLM-driven executor (2D 实施).
 */
const defaultEchoFallback: SubAgentExecutor = async (task) => ({
  task_id: task.id,
  ok: true,
  output: `[plan-runner-echo] ${task.prompt}`,
  tool_calls: [],
  duration_ms: 0,
  status: 'completed',
});