/**
 * Sub-agent Runner — 执行 N 个 sub-agent 并行, 返回合并结果
 * 灵枢 V2 Spec 2C-2
 *
 * 借鉴:
 *   - LangGraph Send() primitive (fan-out 触发并行)
 *   - Manus subagent_pool.py (worker pool + 并行 join)
 *   - CrewAI Process.sequential vs Process.hierarchical
 *
 * 设计:
 *   - runSubAgents(tasks, ctx) 返回合并后的字符串 (与 ctx.runStep 接口一致)
 *   - 内部: spawn N 个 → Promise.all → mergeResults
 *   - 支持 abort (ctx.isAborted 在 spawn 后轮询, 已 spawn 的会被 cancel)
 *   - 不抛错: 失败/超时用 SubAgentResult 表达, 全部 ok 才标记整体 ok
 *
 * 注意: 这个模块是 spec §2.1 "SubAgentExecutor" 的具体实现.
 * 它本身不直接调 LLM, 而是把任务委托给一个 LLM 驱动的 executor —
 * 这样 2D (main loop) 可以复用同一个 executor, 子 agent 行为可替换.
 */

import type {
  SubAgentTask,
  SubAgentResult,
  SubAgentContext,
  SubAgentExecutor,
} from './types.js';
import { spawn, type SubAgentHandle } from './spawn.js';
import { mergeResults, allOk, maxDuration } from './merge.js';
import { globalSubAgentSemaphore } from './semaphore.js';

/**
 * Runner 上下文 — 与 plan/runner.ts 的 RunnerContext 保持类似接口.
 * 主要差异: 多了 allowed_tools 注入和 abort 检查.
 */
export interface SubAgentRunnerContext {
  /** 子 agent 执行器 — 测试注入 mock, 真实场景由 PlanRunner 注入 LLM-driven executor */
  executor?: SubAgentExecutor;
  /** 检查是否被中止 (父 plan 被用户停止) */
  isAborted?: () => boolean;
  /** Awareness 广播回调；spawned/completed/progress 均从此处发出。 */
  awareness?: (event: import('../agent/awareness.js').AwarenessEvent) => void;
  /** progress 心跳间隔，默认 250ms。 */
  progressIntervalMs?: number;
}

/** 单步结果 — 与 PlanRunner.runStep 对齐 */
export interface SubAgentStepOutcome {
  /** 合并后的字符串, 给 PlanRunner 当 result 用 */
  merged_output: string;
  /** 全部结果 (raw), 便于审计/调试 */
  results: SubAgentResult[];
  /** 整体 ok 状态 */
  ok: boolean;
  /** wall-clock duration (max of all) — 用于验证并行 */
  wall_clock_ms: number;
}

/**
 * 并行执行一组 SubAgentTask.
 *
 * 流程:
 *   1. 立即 spawn 全部 (fire-and-forget, 拿到 handle)
 *   2. Promise.all(handle.done) 等待
 *   3. merge + 返回
 *
 * 关键约束: spawn 是同步 (立即返回 handle), Promise.all 才是异步等待.
 * 因此 wall-clock 接近 max(单任务时间), 而不是 sum — 这是 spec §5 DoD 的核心断言.
 */
export async function runSubAgents(
  tasks: SubAgentTask[],
  ctx: SubAgentRunnerContext,
): Promise<SubAgentStepOutcome> {
  if (tasks.length === 0) {
    return { merged_output: '', results: [], ok: true, wall_clock_ms: 0 };
  }

  const startMs = Date.now();

  // H8: 全局 sub-agent 并发限制 (8), 避免 fan-out 打爆 LLM provider.
  // 策略: 每个 task 自己 acquire, 完成后 release — 这样 8 个并发跑,
  // 第 9 个及以后等前一个 release 再进.

  // H8: 用 acquirePromise 模式 — 先串行准备一个"先 acquire 再 spawn"的
  // 闭包数组, 然后 Promise.all. 这样 spawn 是同步但只在 slot 拿到后才执行.
  const inflight = globalSubAgentSemaphore;
  const startAcquires: Array<() => Promise<SubAgentHandle>> = tasks.map((task) => {
    return async () => {
      await inflight.acquire();
      // spawn 是同步的, 在 slot 拿到后才启动 executor
      return spawn(task, { executor: (ctx as any).executor, awareness: ctx.awareness });
    };
  });
  const handles: SubAgentHandle[] = await Promise.all(
    startAcquires.map((fn) => fn().then((h) => {
      // 跟踪 release 钩子 — 完成后 release
      const donePromise = h.done.finally(() => inflight.release());
      return { ...h, done: donePromise };
    })),
  );
  const progressTimer = ctx.awareness
    ? setInterval(() => {
      for (const h of handles) {
        ctx.awareness!({
          kind: 'subagent.progress',
          subagent_id: h.subagent_id,
          task_id: h.task.id,
          status: 'running',
        });
      }
    }, ctx.progressIntervalMs ?? 250)
    : undefined;
  if (progressTimer && typeof (progressTimer as NodeJS.Timeout).unref === 'function') {
    (progressTimer as NodeJS.Timeout).unref();
  }

  // Phase 2: 等待全部完成 — Promise.all 触发真正的并行
  // 同时支持 abort: ctx.isAborted 存在时, 用 race 周期检查; 否则直接 await.
  // Semaphore slot 在 handle 创建时已 acquire, 在 h.done.finally 自动 release.
  const results = await Promise.all(
    handles.map(async (h) => {
      if (!ctx.isAborted) {
        // 简化路径: 没有 abort 检查, 直接 await
        return await h.done;
      }
      // 有 abort: 周期检查
      while (true) {
        if (ctx.isAborted()) {
          h.cancel();
          break;
        }
        const doneOrAbort = await Promise.race([
          h.done,
          abortTick(50),
        ]);
        if (doneOrAbort === 'aborted') {
          // tick 赢了 → 继续轮询 (除非已被 abort)
          if (ctx.isAborted()) {
            h.cancel();
            break;
          }
          continue;  // 关键: 不要把 'aborted' 字符串当 result 返回
        }
        // 是 done 的 SubAgentResult
        return doneOrAbort;
      }
      // 被 abort → 返回一个 failed result
      return {
        task_id: h.task.id,
        ok: false,
        error: 'aborted by parent',
        tool_calls: [],
        duration_ms: Date.now() - startMs,
        status: 'failed' as const,
      };
    }),
  );

  if (progressTimer) clearInterval(progressTimer);
  const merged = mergeResults(results);
  const wallClock = Date.now() - startMs;

  return {
    merged_output: merged,
    results,
    ok: allOk(results),
    wall_clock_ms: wallClock,
  };
}

/** 周期性 resolve 'aborted' 让外层 race 检查 */
function abortTick(ms: number): Promise<'aborted'> {
  return new Promise((resolve) => setTimeout(() => resolve('aborted'), ms));
}

/**
 * 默认 executor — 直接把 prompt 透传 (用于测试 + fallback).
 * 真实场景 (main loop 接入) 由 PlanRunner 注入 LLM-driven executor.
 *
 * 借鉴 Manus `subagent_pool.py`: 子 agent 是 LLM loop, 这里我们留接口,
 * 默认实现是 "echo" 风格 — 让 caller 知道要替换它.
 */
export const defaultEchoExecutor: SubAgentExecutor = async (task) => ({
  task_id: task.id,
  ok: true,
  output: `[echo-executor] ${task.prompt}`,
  tool_calls: [],
  duration_ms: 0,
  status: 'completed',
});

// 导出 wall-clock 校验工具 (供测试/上游使用)
export { maxDuration };