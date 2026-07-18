/**
 * Goal Mode — 灵枢 V2 目标驱动执行核心
 *
 * 设计原则（用户原话）：
 *   - 「目标模式不设那个什么了, 就是他可以一直跑下去直到任务完成」
 *   - 没有 iteration budget 上限 — while(true) 是默认循环
 *   - 唯一出口: 验收全过 → complete / 用户主动停 → aborted
 *
 * 软安全网（不破坏循环）：
 *   - 超 30 分钟 + 每 10 步 → 通过 Awareness 询问用户"是否继续"
 *   - isAborted() 检查 → 用户点"停止目标"按钮时返回 true
 *
 * 借鉴：
 *   - Hermes `iteration-budget.ts`: 主循环 + 软超时
 *   - Hermes `convergence.ts`: 多条独立布尔判定 → 整体完成
 *   - OpenCode LLM-as-judge: verifier 自我声明 + LLM 二次校验
 */

import { randomUUID } from 'node:crypto';
import type { AcceptanceCriterion } from './acceptance.js';
import { allPassed } from './acceptance.js';
import type { LLMProvider } from './verifier.js';
import { checkAcceptance } from './verifier.js';
import { TIMEOUTS } from '../config/constants.js';

export type GoalStatus = 'running' | 'complete' | 'partial' | 'aborted' | 'paused';

export interface Goal {
  id: string;
  statement: string;
  acceptance: AcceptanceCriterion[];
  status: GoalStatus;
  iterations: number;
  started_at: number;
  contextSummary: string;
}

/**
 * AgentContext — 目标模式与主循环的边界接口。
 * 灵枢主循环任务（Phase 6 后续）会实现此接口。
 * 现在测试用 mock。
 */
export interface AgentContext {
  /** 执行一步，返回该步的上下文摘要（用于 verifier 评估） */
  runOnce(goal: Goal): Promise<string>;
  /** 用户是否中止（点"停止目标"按钮 → 返回 true） */
  isAborted(): boolean;
  /** 通过 Awareness 询问用户"是否继续"（软超时） */
  askUserContinue(message: string): Promise<void>;
}

/**
 * 解析用户输入的"目标 + 验收清单"DSL。
 * 格式:
 *   目标: <陈述>
 *   验收:
 *   1) <条目1>
 *   2) <条目2>
 *
 * 兼容:
 *   - 半角冒号 `:` / 全角冒号 `：`
 *   - 无验收块 → 整段作为 statement
 *   - 无 "目标:" 前缀 → 整段作为 statement
 */
export function parseGoal(input: string): Goal {
  const goalMatch = input.match(/目标[:：]\s*(.+?)(?=\n\s*验收|$)/s);
  const acceptMatch = input.match(/验收[:：]\s*([\s\S]+)$/);

  if (!goalMatch) {
    // fallback: 整段当作目标, 验收空
    return createGoal(input.trim(), []);
  }
  return createGoal(goalMatch[1].trim(), parseAcceptance(acceptMatch?.[1] ?? ''));
}

function parseAcceptance(input: string): AcceptanceCriterion[] {
  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  return lines
    .map(l => l.replace(/^(\d+\)|-|\*)\s*/, '').trim())
    .filter(text => text.length > 0)
    .map(text => ({ text }));
}

function createGoal(statement: string, acceptance: AcceptanceCriterion[]): Goal {
  return {
    id: randomUUID(),
    statement,
    acceptance,
    status: 'running',
    iterations: 0,
    started_at: Date.now(),
    contextSummary: '',
  };
}

/**
 * 软超时阈值（毫秒）— 用户原话「跑超 30 分钟软询问」
 * 不切断循环，只是询问用户"是否继续"。
 */
const SOFT_TIMEOUT_MS = 30 * 60 * 1000;
/** 每隔多少步询问一次（避免每次循环都问） */
const SOFT_PROMPT_EVERY_N_ITERATIONS = 10;
/** 硬上限: 防止 verifier 永远不通过时无限占用资源。 */
const MAX_GOAL_ITERATIONS = TIMEOUTS.MAX_GOAL_ITERATIONS;

export class GoalBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalBudgetExceededError';
  }
}

/**
 * 跑目标循环 — 无 budget 上限。
 *
 * 循环步骤（每次迭代）：
 *   1. iterations++
 *   2. ctx.runOnce(goal) → 新 contextSummary
 *   3. onIteration(goal)  — UI 可订阅用于实时展示
 *   4. checkAcceptance(...) → verdict → 写入 passed/evidence
 *   5. 全过 → status='complete', return
 *   6. 软超时（>30min && iterations%10==0） → askUserContinue
 *   7. isAborted() → status='aborted', return
 *   8. 否则继续
 */
export async function runGoalLoop(
  goal: Goal,
  ctx: AgentContext,
  llm: LLMProvider,
  onIteration: (g: Goal) => void,
): Promise<Goal> {
  while (true) {
    // 硬上限: 防止 verifier 永远不通过时无限占用资源。
    // 检查在 runOnce 之前, 这样 iteration=200 时已经抛错 (runOnce 调用次数恰好 200)
    if (goal.iterations >= MAX_GOAL_ITERATIONS) {
      goal.status = 'aborted';
      throw new GoalBudgetExceededError(
        `Goal hit hard iteration budget (${MAX_GOAL_ITERATIONS}); aborting to prevent infinite loop`,
      );
    }
    goal.iterations++;
    goal.contextSummary = await ctx.runOnce(goal);
    onIteration(goal);

    // Spec 2A I2 — verifier resilience: borrow Hermes convergence.ts pattern.
    // If checkAcceptance throws (LLM returned non-JSON, network blip, etc.),
    // log and continue — goal.acceptance entries stay `passed: undefined`,
    // allPassed() returns false, loop keeps iterating instead of aborting.
    // Previously this try/catch lived in main-loop.ts's runGoalLoopWithVerifierGuard;
    // moved here so the loop owns its own resilience.
    try {
      const verdict = await checkAcceptance(goal.acceptance, goal.contextSummary, llm);
      goal.acceptance = goal.acceptance.map((c, i) => ({
        ...c,
        passed: verdict.results[i]?.passed,
        evidence: verdict.results[i]?.evidence,
      }));
    } catch (err) {
      // verifier 解析失败 → log + 保留 passed=undefined → allPassed 返 false → 继续
      console.error('[goal] verifier error, continuing:', err instanceof Error ? err.message : String(err));
    }

    if (allPassed(goal.acceptance)) {
      goal.status = 'complete';
      return goal;
    }

    // 软安全网: >30 分钟 && 每 10 步 → 通过 Awareness 询问用户
    const elapsedMs = Date.now() - goal.started_at;
    if (
      elapsedMs > SOFT_TIMEOUT_MS &&
      goal.iterations % SOFT_PROMPT_EVERY_N_ITERATIONS === 0
    ) {
      const elapsedMin = Math.round(elapsedMs / 60000);
      const passedCount = goal.acceptance.filter(c => c.passed).length;
      // M21: race askUserContinue against a 30s timeout. If the user
      // doesn't respond in time we pause the goal (safer default than
      // silently continuing an unbounded loop).
      const continueDecision = await Promise.race([
        ctx.askUserContinue(
          `目标已跑 ${elapsedMin} 分钟, 进度 ${passedCount}/${goal.acceptance.length}, 继续吗？`,
        ).then(() => 'continue' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
      ]);
      if (continueDecision === 'timeout') {
        // 30 秒无回应 → 默认暂停 (而非继续), 避免无人监管时无限消耗资源
        goal.status = 'paused';
        return goal;
      }
    }

    // 用户可手动停 — 通过 abort signal 检查
    if (ctx.isAborted()) {
      goal.status = 'aborted';
      return goal;
    }
  }
}