/**
 * Message Bus 测试 — Spec 2C-2
 * TDD: 先验行为再写实现.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSubAgentMessageBus } from './message-bus.js';
import type { SubAgentResult } from './types.js';

describe('createSubAgentMessageBus', () => {
  it('emits a spawn message and stores it in history', () => {
    const bus = createSubAgentMessageBus();
    bus.emit({ kind: 'spawn', task_id: 't1', subagent_id: 'sa1', ts: 100 });
    expect(bus.history()).toHaveLength(1);
    expect(bus.history()[0]!.kind).toBe('spawn');
  });

  it('awaitComplete resolves immediately if complete message already exists', async () => {
    const bus = createSubAgentMessageBus();
    const result: SubAgentResult = {
      task_id: 't1',
      ok: true,
      output: 'done',
      tool_calls: [],
      duration_ms: 50,
      status: 'completed',
    };
    bus.emit({ kind: 'spawn', task_id: 't1', subagent_id: 'sa1', ts: 100 });
    bus.emit({ kind: 'complete', subagent_id: 'sa1', task_id: 't1', result, ts: 150 });

    const msg = await bus.awaitComplete('sa1');
    expect(msg.kind).toBe('complete');
    if (msg.kind === 'complete') {
      expect(msg.result.output).toBe('done');
    }
  });

  it('awaitComplete resolves when complete message arrives later', async () => {
    const bus = createSubAgentMessageBus();
    const promise = bus.awaitComplete('sa1');

    // 先不开 resolve
    const result: SubAgentResult = {
      task_id: 't1',
      ok: true,
      output: 'late',
      tool_calls: [],
      duration_ms: 30,
      status: 'completed',
    };
    setTimeout(() => {
      bus.emit({ kind: 'complete', subagent_id: 'sa1', task_id: 't1', result, ts: 200 });
    }, 10);

    const msg = await promise;
    expect(msg.kind).toBe('complete');
    if (msg.kind === 'complete') {
      expect(msg.result.output).toBe('late');
    }
  });

  it('historyForTask filters messages by task_id', () => {
    const bus = createSubAgentMessageBus();
    bus.emit({ kind: 'spawn', task_id: 't1', subagent_id: 'sa1', ts: 1 });
    bus.emit({ kind: 'spawn', task_id: 't2', subagent_id: 'sa2', ts: 2 });
    bus.emit({ kind: 'progress', subagent_id: 'sa1', task_id: 't1', status: 'running', ts: 3 });

    const t1 = bus.historyForTask('t1');
    expect(t1).toHaveLength(2);
    expect(t1.every((m) => m.task_id === 't1')).toBe(true);
  });

  it('progress messages can be emitted without affecting complete waiters', async () => {
    const bus = createSubAgentMessageBus();
    const wait = bus.awaitComplete('sa1');
    bus.emit({ kind: 'progress', subagent_id: 'sa1', task_id: 't1', status: 'running', ts: 1 });
    bus.emit({ kind: 'progress', subagent_id: 'sa1', task_id: 't1', status: 'still running', ts: 2 });

    // wait 还没 resolve
    let resolved = false;
    void wait.then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    // 现在 complete 来了 → resolve
    bus.emit({
      kind: 'complete',
      subagent_id: 'sa1',
      task_id: 't1',
      result: { task_id: 't1', ok: true, tool_calls: [], duration_ms: 1, status: 'completed' },
      ts: 3,
    });
    await wait;
  });

  it('close clears pending waiters (no leak)', () => {
    const bus = createSubAgentMessageBus();
    void bus.awaitComplete('sa1');
    void bus.awaitComplete('sa2');
    bus.close();
    // close 后再 emit complete 不会触发 awaitComplete (因为 waiters 已清)
    // 这个测试主要确保 close 不抛错
    expect(() => bus.close()).not.toThrow();
  });

  it('multiple waiters for same subagent_id all resolve on complete', async () => {
    const bus = createSubAgentMessageBus();
    const w1 = bus.awaitComplete('sa1');
    const w2 = bus.awaitComplete('sa1');
    const w3 = bus.awaitComplete('sa1');

    bus.emit({
      kind: 'complete',
      subagent_id: 'sa1',
      task_id: 't1',
      result: { task_id: 't1', ok: true, tool_calls: [], duration_ms: 0, status: 'completed' },
      ts: 1,
    });

    const [m1, m2, m3] = await Promise.all([w1, w2, w3]);
    expect(m1.kind).toBe('complete');
    expect(m2.kind).toBe('complete');
    expect(m3.kind).toBe('complete');
  });

  it('history is returned as a copy (mutation safe)', () => {
    const bus = createSubAgentMessageBus();
    bus.emit({ kind: 'spawn', task_id: 't1', subagent_id: 'sa1', ts: 1 });
    const h = bus.history();
    h.push({ kind: 'spawn', task_id: 'fake', subagent_id: 'fake', ts: 999 });
    expect(bus.history()).toHaveLength(1);
  });
});