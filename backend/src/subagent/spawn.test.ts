/**
 * Spawn 测试 — Spec 2C-2
 * 覆盖: 正常完成、失败、超时、cancel、字段校验、并发.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawn } from './spawn.js';
import type { SubAgentTask, SubAgentExecutor } from './types.js';

function makeTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    id: 't1',
    prompt: 'do something',
    parent_goal_id: 'g1',
    parent_step_id: 's1',
    timeout_ms: 5000,
    ...overrides,
  };
}

/** 工厂: 返回一个 ok=true 的 executor, 同时返回 mock 供断言 */
function makeOkExecutor(output = 'done'): { executor: SubAgentExecutor; mock: ReturnType<typeof vi.fn> } {
  const fn: SubAgentExecutor = async (task) => ({
    task_id: task.id,
    ok: true,
    output,
    tool_calls: [],
    duration_ms: 10,
    status: 'completed',
  });
  const mock = vi.fn(fn);
  return { executor: mock as unknown as SubAgentExecutor, mock };
}

describe('spawn', () => {
  it('completes successfully when executor returns ok result', async () => {
    const { executor, mock } = makeOkExecutor();
    const handle = spawn(makeTask(), { executor });
    const result = await handle.done;
    expect(result.ok).toBe(true);
    expect(result.output).toBe('done');
    expect(result.status).toBe('completed');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('marks failed when executor throws', async () => {
    const fn: SubAgentExecutor = async () => {
      throw new Error('executor boom');
    };
    const handle = spawn(makeTask(), { executor: fn });
    const result = await handle.done;
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('executor boom');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('times out when executor takes longer than timeout_ms', async () => {
    const fn: SubAgentExecutor = async (task) => {
      await new Promise((r) => setTimeout(r, 200));
      return { task_id: task.id, ok: true, output: 'too late', tool_calls: [], duration_ms: 200, status: 'completed' };
    };
    const handle = spawn(makeTask({ timeout_ms: 50 }), { executor: fn });
    const result = await handle.done;
    expect(result.ok).toBe(false);
    expect(result.status).toBe('timeout');
    expect(result.error).toContain('timeout');
  });

  it('completes immediately if timeout_ms=0 (no timeout)', async () => {
    const fn: SubAgentExecutor = async (task) => ({
      task_id: task.id, ok: true, output: 'forever ok', tool_calls: [], duration_ms: 1, status: 'completed',
    });
    const handle = spawn(makeTask({ timeout_ms: 0 }), { executor: fn });
    const result = await handle.done;
    expect(result.ok).toBe(true);
  });

  it('emits spawn + progress + complete messages on bus', async () => {
    const fn: SubAgentExecutor = async (task) => ({
      task_id: task.id, ok: true, tool_calls: [], duration_ms: 1, status: 'completed', output: 'x',
    });
    const handle = spawn(makeTask(), { executor: fn });
    await handle.done;
    const history = handle.bus.history();
    const kinds = history.map((m) => m.kind);
    expect(kinds[0]).toBe('spawn');
    expect(kinds).toContain('progress');
    expect(kinds[kinds.length - 1]).toBe('complete');
  });

  it('cancel() does not throw and result is defined', async () => {
    let executorStarted = false;
    const fn: SubAgentExecutor = async (task) => {
      executorStarted = true;
      return { task_id: task.id, ok: true, output: 'x', tool_calls: [], duration_ms: 0, status: 'completed' };
    };
    const handle = spawn(makeTask(), { executor: fn });
    handle.cancel();
    const result = await handle.done;
    expect(result).toBeDefined();
    expect(executorStarted).toBe(true);  // microtask 已启动
  });

  it('throws on missing required fields', () => {
    expect(() => spawn({ ...makeTask(), id: '' })).toThrow();
    expect(() => spawn({ ...makeTask(), parent_goal_id: '' })).toThrow();
    expect(() => spawn({ ...makeTask(), parent_step_id: '' })).toThrow();
    // @ts-expect-error - testing runtime guard
    expect(() => spawn({ ...makeTask(), prompt: undefined })).toThrow();
  });

  it('preserves task_id in result regardless of executor behavior', async () => {
    const fn: SubAgentExecutor = async () => {
      throw new Error('x');
    };
    const handle = spawn(makeTask({ id: 'task-xyz' }), { executor: fn });
    const result = await handle.done;
    expect(result.task_id).toBe('task-xyz');
  });

  it('concurrent spawns: Promise.all collects all results', async () => {
    const fn: SubAgentExecutor = async (task) => ({
      task_id: task.id,
      ok: true,
      output: `done-${task.id}`,
      tool_calls: [],
      duration_ms: 10,
      status: 'completed',
    });
    const tasks = [1, 2, 3].map((i) => makeTask({ id: `t${i}` }));
    const handles = tasks.map((t) => spawn(t, { executor: fn }));
    const results = await Promise.all(handles.map((h) => h.done));
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.task_id).sort()).toEqual(['t1', 't2', 't3']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('passes allowed_tools to executor via context', async () => {
    let receivedTools: string[] = [];
    const fn: SubAgentExecutor = async (task, ctx) => {
      receivedTools = ctx.allowed_tools;
      return { task_id: task.id, ok: true, tool_calls: [], duration_ms: 0, status: 'completed', output: 'x' };
    };
    const handle = spawn(makeTask({ allowed_tools: ['read_file', 'search'] }), { executor: fn });
    await handle.done;
    expect(receivedTools).toEqual(['read_file', 'search']);
  });
});