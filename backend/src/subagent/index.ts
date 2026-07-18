/**
 * Sub-agent Public API — 灵枢 V2 Spec 2C-2
 *
 * 这是 sub-agent 体系的对外入口. 外部代码 (plan/runner.ts, main-loop.ts 等)
 * 应该只从这个文件导入, 不直接 import 子模块.
 *
 * 设计:
 *   - 单一入口 (barrel pattern)
 *   - 所有 sub-agent 相关类型从 types.ts re-export
 *   - 4 个核心函数: spawn / runSubAgents / createSubAgentMessageBus / mergeResults
 *   - defaultEchoExecutor 作为测试用 executor re-export (供 unit test / 本地开发复用)
 *
 * 借鉴 CrewAI `from crewai import Agent` 的 barrel 风格.
 */

// ── 类型 (从 types.ts re-export) ────────────────────
export type {
  SubAgentTask,
  SubAgentResult,
  SubAgentStatus,
  SubAgentContext,
  SubAgentExecutor,
  ToolCall,
} from './types.js';
export type { SubAgentMessage, SubAgentMessageBus } from './message-bus.js';

// ── 核心 API ────────────────────────────────
export { spawn } from './spawn.js';
export type { SubAgentHandle, SpawnOptions } from './spawn.js';

export {
  runSubAgents,
  defaultEchoExecutor,
} from './runner.js';
export type { SubAgentRunnerContext, SubAgentStepOutcome } from './runner.js';

export { createSubAgentMessageBus } from './message-bus.js';

export {
  mergeResults,
  allOk,
  anyOk,
  countOk,
  totalToolCalls,
  totalDuration,
  maxDuration,
} from './merge.js';

// ── 常用 helpers ────────────────────────────────
import type { SubAgentTask } from './types.js';

/**
 * 快速构造 N 个并行任务 (共享 parent context).
 * PlanRunner 集成时常用: 为一个 parallel_group 生成 N 个任务.
 * Public helper for constructing parallel sub-agent tasks.
 */
export function makeParallelTasks(
  parentGoalId: string,
  parentStepId: string,
  prompts: string[],
  timeoutMs = 60_000,
): SubAgentTask[] {
  return prompts.map((prompt, i) => ({
    id: `pt_${parentStepId}_${i}_${Date.now()}`,
    prompt,
    parent_goal_id: parentGoalId,
    parent_step_id: parentStepId,
    timeout_ms: timeoutMs,
  }));
}