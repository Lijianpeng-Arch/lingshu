import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMainLoop } from './main-loop.js';
import { registerAwarenessHandlers } from './awareness.js';
import type { MainLoopDeps } from './main-loop.js';
import type { AwarenessHandler } from './awareness.js';
import type { UACSEnvelope, UACSEnvelopeType, AwarenessSnapshotPayload } from '../uacs/envelope.js';
import { createSqlite } from '../db/sqlite.js';

function makeLoop(): ReturnType<typeof createMainLoop> {
  // Spec 2C-1: use real createSqlite so plan tables exist
  const dir = mkdtempSync(join(tmpdir(), 'lingshu-aw-'));
  const dbPath = join(dir, 'aw.sqlite');
  const db = createSqlite(dbPath);
  const deps: MainLoopDeps = {
    db,
    broadcast: () => {},
    hasPendingUserMessage: () => false,
    hasActiveTask: () => false,
    isRateLimited: () => false,
    awakeningTicks: () => 99,
    reminderDueMs: () => undefined,
    startedAtMs: Date.now(),
  };
  return createMainLoop(deps);
}

function makeEnvelope(type: UACSEnvelopeType): UACSEnvelope {
  return {
    id: `env-${type}`,
    type,
    sender: 'electron',
    recipient: 'soul',
    timestamp: 1700000000000,
    correlationId: null,
    traceMeta: {},
    payload: undefined,
  } as UACSEnvelope;
}

describe('Awareness snapshot', () => {
  it('default snapshot has emotion=idle and mode=idle', () => {
    const loop = makeLoop();
    const snap = loop.getSnapshot();
    expect(snap.emotion).toBe('idle');
    expect(snap.status.mode).toBe('idle');
    expect(snap.tasks).toEqual([]);
    expect(snap.thoughts).toEqual([]);
  });
});

describe('Awareness update payload', () => {
  it('buildUpdate returns the correct kind and data', () => {
    const loop = makeLoop();
    const update = loop.buildUpdate('thought', { content: 'X' });
    expect(update.kind).toBe('thought');
    expect(update.data).toEqual({ content: 'X' });
  });

  it('emotion update mutates currentEmotion and next snapshot reflects it', () => {
    const loop = makeLoop();
    loop.buildUpdate('emotion', 'thinking');
    const snap = loop.getSnapshot();
    expect(snap.emotion).toBe('thinking');
  });

  it('task update returns correct kind and data', () => {
    // I15 review: 覆盖第 3 种 kind (task)
    const loop = makeLoop();
    const update = loop.buildUpdate('task', { id: 't1', title: 'X', status: 'running' });
    expect(update.kind).toBe('task');
    expect(update.data).toEqual({ id: 't1', title: 'X', status: 'running' });
  });

  it('status update returns correct kind and data', () => {
    // I15 review: 覆盖第 4 种 kind (status)
    const loop = makeLoop();
    const update = loop.buildUpdate('status', { mode: 'busy', uptime: 42 });
    expect(update.kind).toBe('status');
    expect(update.data).toEqual({ mode: 'busy', uptime: 42 });
  });
});

describe('registerAwarenessHandlers', () => {
  it('awareness.snapshot handler broadcasts a snapshot envelope back', async () => {
    const loop = makeLoop();
    const registry = new Map<UACSEnvelopeType, AwarenessHandler>();
    registerAwarenessHandlers({ mainLoop: loop }, (type, handler) => {
      registry.set(type, handler);
    });

    const handler = registry.get('awareness.snapshot');
    expect(handler).toBeDefined();
    const result = (await handler!(makeEnvelope('awareness.snapshot'))) as UACSEnvelope;
    expect(result.type).toBe('awareness.snapshot');
    const payload = result.payload as AwarenessSnapshotPayload;
    expect(payload.emotion).toBe('idle');
    expect(payload.status.mode).toBe('idle');
  });

  it('awareness.update handler logs and acks', async () => {
    const loop = makeLoop();
    const registry = new Map<UACSEnvelopeType, AwarenessHandler>();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerAwarenessHandlers({ mainLoop: loop }, (type, handler) => {
      registry.set(type, handler);
    });

    const handler = registry.get('awareness.update');
    expect(handler).toBeDefined();
    const env = makeEnvelope('awareness.update');
    env.payload = { kind: 'thought', data: { content: 'X' } } as any;
    const result = (await handler!(env)) as UACSEnvelope;
    expect(result.type).toBe('awareness.snapshot');
    expect((result.payload as unknown as { ack: boolean }).ack).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith('[awareness.update]', env.payload);
    consoleSpy.mockRestore();
  });
});