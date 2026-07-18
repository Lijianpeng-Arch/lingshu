/**
 * Runner 测试 — Spec 2C-2
 * 关键验证: 3 个并行 1s 任务 wall-clock < 1.5s (DoD §5 #3)
 */

import { describe, it, expect, vi } from 'vitest';
import { runSubAgents, defaultEchoExecutor } from './runner.js';
import type { SubAgentTask, SubAgentResult, SubAgentExecutor, SubAgentContext } from './types.js';

function makeTask(id: string, prompt: string, overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    id,
    prompt,
    parent_goal_id: 'g1',
    parent_step_id: 's1',
    timeout_ms: 5000,
    ...overrides,
  };
}

describe('runSubAgents', () => {
  it('returns merged_output from single task', async () => {
    const executor: SubAgentExecutor = async (task) => ({
      task_id: task.id,
      ok: true,
      output: 'single-result',
      tool_calls: [],
      duration_ms: 1,
      status: 'completed',
    });
    const outcome = await runSubAgents([makeTask('t1', 'do')], { executor });
    expect(outcome.ok).toBe(true);
    expect(outcome.merged_output).toContain('single-result');
    expect(outcome.results).toHaveLength(1);
  });

  it('runs tasks in parallel: wall-clock < sum of individual durations', async () => {
    // 3 个任务各睡 300ms → 串行 900ms, 并行 ~300ms
    const executor: SubAgentExecutor = async (task) => {
      await new Promise((r) => setTimeout(r, 300));
      return {
        task_id: task.id,
        ok: true,
        output: `done-${task.id}`,
        tool_calls: [],
        duration_ms: 300,
        status: 'completed',
      };
    };
    const tasks = [makeTask('t1', 'a'), makeTask('t2', 'b'), makeTask('t3', 'c')];
    const start = Date.now();
    const outcome = await runSubAgents(tasks, { executor });
    const elapsed = Date.now() - start;

    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(3);
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    // 关键: wall-clock < sum (=900ms), 并行下应该接近 300ms
    // 加 200ms buffer 防止 CI 抖动
    expect(elapsed).toBeLessThan(600);
    // 同时: wall-clock 应该 ≈ 300ms (最慢任务的时长), 远小于 900ms
    expect(outcome.wall_clock_ms).toBeLessThan(600);
    // 合并输出包含全部 3 个
    expect(outcome.merged_output).toContain('done-t1');
    expect(outcome.merged_output).toContain('done-t2');
    expect(outcome.merged_output).toContain('done-t3');
  });

  it('limits global sub-agent concurrency to eight', async () => {
    let active = 0;
    let maxActive = 0;
    const executor: SubAgentExecutor = async (task) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return {
        task_id: task.id,
        ok: true,
        output: `done-${task.id}`,
        tool_calls: [],
        duration_ms: 25,
        status: 'completed',
      };
    };

    const tasks = Array.from({ length: 12 }, (_, i) => makeTask(`t${i}`, `p${i}`));
    const outcome = await runSubAgents(tasks, { executor });

    expect(outcome.ok).toBe(true);
    expect(maxActive).toBe(8);
  });

  it('does NOT throw when some tasks fail (graceful)', async () => {
    const executor: SubAgentExecutor = async (task) => {
      if (task.id === 't2') throw new Error('t2 boom');
      return { task_id: task.id, ok: true, output: 'ok', tool_calls: [], duration_ms: 0, status: 'completed' };
    };
    const outcome = await runSubAgents(
      [makeTask('t1', 'a'), makeTask('t2', 'b'), makeTask('t3', 'c')],
      { executor },
    );
    expect(outcome.ok).toBe(false);  // 整体不是全 ok
    expect(outcome.results.find((r) => r.task_id === 't2')!.status).toBe('failed');
    expect(outcome.merged_output).toContain('ok');
    expect(outcome.merged_output).toContain('boom');
  });

  it('handles empty task list', async () => {
    const outcome = await runSubAgents([], { executor: defaultEchoExecutor });
    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(0);
    expect(outcome.merged_output).toBe('');
    expect(outcome.wall_clock_ms).toBe(0);
  });

  it('respects timeout_ms: slow tasks get marked timeout', async () => {
    const executor: SubAgentExecutor = async (task) => {
      await new Promise((r) => setTimeout(r, 500));
      return { task_id: task.id, ok: true, output: 'slow', tool_calls: [], duration_ms: 500, status: 'completed' };
    };
    const tasks = [
      makeTask('t1', 'a', { timeout_ms: 50 }),
      makeTask('t2', 'b', { timeout_ms: 50 }),
    ];
    const outcome = await runSubAgents(tasks, { executor });
    expect(outcome.results.every((r) => r.status === 'timeout')).toBe(true);
    expect(outcome.ok).toBe(false);
  });

  it('passes task-specific context to executor (allowed_tools isolation)', async () => {
    const receivedCtx: SubAgentContext[] = [];
    const executor: SubAgentExecutor = async (task, ctx) => {
      receivedCtx.push(ctx);
      return { task_id: task.id, ok: true, output: 'x', tool_calls: [], duration_ms: 0, status: 'completed' };
    };
    await runSubAgents(
      [
        makeTask('t1', 'a', { allowed_tools: ['read_file'] }),
        makeTask('t2', 'b', { allowed_tools: ['grep', 'search'] }),
      ],
      { executor },
    );
    expect(receivedCtx[0]!.allowed_tools).toEqual(['read_file']);
    expect(receivedCtx[1]!.allowed_tools).toEqual(['grep', 'search']);
  });

  it('aborts pending tasks when ctx.isAborted() returns true', async () => {
    const executor: SubAgentExecutor = async (task) => {
      await new Promise((r) => setTimeout(r, 200));
      return { task_id: task.id, ok: true, output: 'x', tool_calls: [], duration_ms: 200, status: 'completed' };
    };
    // abort 在第一次检查时就返回 true
    const outcome = await runSubAgents(
      [makeTask('t1', 'a'), makeTask('t2', 'b')],
      { executor, isAborted: () => true },
    );
    // 全部标记为失败 (aborted)
    expect(outcome.ok).toBe(false);
    expect(outcome.results.every((r) => r.status === 'failed')).toBe(true);
    expect(outcome.results.every((r) => r.error?.includes('aborted'))).toBe(true);
  });

  it('preserves task_id in every result (no id leak)', async () => {
    const executor: SubAgentExecutor = async (task) => ({
      task_id: task.id, ok: true, output: task.prompt, tool_calls: [], duration_ms: 0, status: 'completed',
    });
    const ids = ['alpha', 'beta', 'gamma'];
    const outcome = await runSubAgents(
      ids.map((id) => makeTask(id, `p-${id}`)),
      { executor },
    );
    const resultIds = outcome.results.map((r) => r.task_id).sort();
    expect(resultIds).toEqual(['alpha', 'beta', 'gamma']);
  });
});