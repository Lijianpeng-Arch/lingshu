import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPermissionCoordinator, type PermissionGate } from './permission-coordinator.js';
import type { PermissionDecision } from '../permission/types.js';

/** Build a gate that always returns a fixed decision. */
function fixedGate(decision: PermissionDecision): PermissionGate {
  return () => decision;
}

describe('createPermissionCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns allow immediately when gate allows', async () => {
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'allow' }),
      defaultTimeoutMs: 1000,
    });
    await expect(coord.gateCall('read_file', {})).resolves.toEqual({ kind: 'allow' });
    expect(coord.pendingCount()).toBe(0);
  });

  it('returns deny immediately when gate denies', async () => {
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'deny', reason: 'rule' }),
      defaultTimeoutMs: 1000,
    });
    await expect(coord.gateCall('rm', {})).resolves.toEqual({ kind: 'deny', reason: 'rule' });
    expect(coord.pendingCount()).toBe(0);
  });

  it('registers a pending request when gate asks', async () => {
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'ask', reason: 'confirm' }),
      defaultTimeoutMs: 1000,
      idFactory: () => 'req-1',
    });
    const promise = coord.gateCall('run_command', { command: 'ls' });
    // Allow the async gateCall body to register the pending entry.
    await Promise.resolve();
    expect(coord.pendingCount()).toBe(1);
    expect(coord.pendingRequest('req-1')).toBe(true);
    // Clean up so the test doesn't leave a dangling promise.
    coord.resolveRequest('req-1', 'deny');
    await promise;
  });

  it('resolveRequest allow settles a pending ask', async () => {
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'ask', reason: 'confirm' }),
      defaultTimeoutMs: 1000,
      idFactory: () => 'req-1',
    });
    const promise = coord.gateCall('run_command', {});
    await Promise.resolve();
    coord.resolveRequest('req-1', 'allow');
    await expect(promise).resolves.toEqual({ kind: 'allow' });
    expect(coord.pendingCount()).toBe(0);
    expect(coord.pendingRequest('req-1')).toBe(false);
  });

  it('resolveRequest deny carries the reason', async () => {
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'ask', reason: 'confirm' }),
      defaultTimeoutMs: 1000,
      idFactory: () => 'req-1',
    });
    const promise = coord.gateCall('run_command', {});
    await Promise.resolve();
    coord.resolveRequest('req-1', 'deny', 'user said no');
    await expect(promise).resolves.toEqual({ kind: 'deny', reason: 'user said no' });
  });

  it('auto-denies with reason "timeout" after defaultTimeoutMs', async () => {
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'ask', reason: 'confirm' }),
      defaultTimeoutMs: 5000,
      idFactory: () => 'req-1',
    });
    const promise = coord.gateCall('run_command', {});
    await Promise.resolve();
    expect(coord.pendingCount()).toBe(1);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ kind: 'deny', reason: 'timeout' });
    expect(coord.pendingCount()).toBe(0);
  });

  it('bypassConfirm=true short-circuits ask into allow', async () => {
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'ask', reason: 'confirm' }),
      defaultTimeoutMs: 1000,
    });
    await expect(coord.gateCall('run_command', {}, { bypassConfirm: true })).resolves.toEqual({
      kind: 'allow',
    });
    expect(coord.pendingCount()).toBe(0);
  });

  it('cancelAll denies and clears all pending requests', async () => {
    let n = 0;
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'ask', reason: 'confirm' }),
      defaultTimeoutMs: 1000,
      idFactory: () => `req-${++n}`,
    });
    const p1 = coord.gateCall('a', {});
    const p2 = coord.gateCall('b', {});
    await Promise.resolve();
    expect(coord.pendingCount()).toBe(2);
    coord.cancelAll('stopped');
    await expect(p1).resolves.toEqual({ kind: 'deny', reason: 'stopped' });
    await expect(p2).resolves.toEqual({ kind: 'deny', reason: 'stopped' });
    expect(coord.pendingCount()).toBe(0);
  });

  it('handles multiple concurrent pending requests independently', async () => {
    let n = 0;
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'ask', reason: 'confirm' }),
      defaultTimeoutMs: 1000,
      idFactory: () => `req-${++n}`,
    });
    const p1 = coord.gateCall('a', {});
    const p2 = coord.gateCall('b', {});
    await Promise.resolve();
    expect(coord.pendingCount()).toBe(2);
    coord.resolveRequest('req-1', 'allow');
    await expect(p1).resolves.toEqual({ kind: 'allow' });
    expect(coord.pendingCount()).toBe(1);
    coord.resolveRequest('req-2', 'deny');
    await expect(p2).resolves.toEqual({ kind: 'deny', reason: 'Denied by user' });
    expect(coord.pendingCount()).toBe(0);
  });

  it('resolveRequest on an unknown id is a silent no-op', () => {
    const coord = createPermissionCoordinator({
      gate: fixedGate({ kind: 'ask', reason: 'confirm' }),
      defaultTimeoutMs: 1000,
    });
    expect(() => coord.resolveRequest('nope', 'allow')).not.toThrow();
    expect(coord.pendingCount()).toBe(0);
  });
});
