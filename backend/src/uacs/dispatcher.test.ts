import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDispatcher, emitCapabilityInvoke, awaitCapabilityResult, _clearInflightCapabilitiesForTest } from './dispatcher.js';
import type { UACSEnvelope } from './envelope.js';

const env = (overrides: Partial<UACSEnvelope> = {}): UACSEnvelope => ({
  id: 'env-1', type: 'chat.request', sender: 'electron', recipient: 'backend',
  timestamp: 1700000000000, correlationId: null, traceMeta: {},
  payload: { messages: [{ role: 'user', content: 'hi' }], sessionId: 'sess-1' },
  ...overrides,
} as UACSEnvelope);

describe('createDispatcher', () => {
  it('dispatches to handler by type', async () => {
    const d = createDispatcher();
    const h = vi.fn().mockResolvedValue(undefined);
    d.register('chat.request', h);
    await d.dispatch(env());
    expect(h).toHaveBeenCalled();
  });

  it('throws when no handler registered', async () => {
    const d = createDispatcher();
    await expect(d.dispatch(env())).rejects.toThrow(/No handler/);
  });

  it('registers multiple handlers', async () => {
    const d = createDispatcher();
    const h1 = vi.fn();
    const h2 = vi.fn();
    d.register('chat.request', h1);
    d.register('acui.show', h2);
    await d.dispatch(env());
    await d.dispatch(env({ type: 'acui.show', payload: { component: 'X', props: {} } } as any));
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('unregister removes handler', async () => {
    const d = createDispatcher();
    const h = vi.fn();
    d.register('chat.request', h);
    d.unregister('chat.request');
    await expect(d.dispatch(env())).rejects.toThrow(/No handler/);
  });

  it('logs but does not crash when handler throws', async () => {
    const d = createDispatcher();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    d.register('chat.request', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(d.dispatch(env())).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('supports wildcard handler', async () => {
    const d = createDispatcher();
    const w = vi.fn();
    d.registerWildcard(w);
    await d.dispatch(env());
    await d.dispatch(env({ type: 'error', payload: { code: 'X', message: 'y' } } as any));
    expect(w).toHaveBeenCalledTimes(2);
  });
});

describe('Phase C.4 — capability.invoke / capability.result real handlers', () => {
  afterEach(() => {
    _clearInflightCapabilitiesForTest();
  });

  it('emitCapabilityInvoke generates invokeId and emits capability.invoke envelope', () => {
    const source = env({ id: 'src-1', correlationId: 'corr-1', traceMeta: { sessionId: 'sess-x' } });
    const emitted: UACSEnvelope[] = [];
    const invokeId = emitCapabilityInvoke({
      capability: 'browser',
      args: { action: 'navigate', url: 'https://example.com' },
      source,
      emit: (e) => emitted.push(e),
    });

    expect(invokeId).toMatch(/^cap-[0-9a-f-]{36}$/);
    expect(emitted).toHaveLength(1);
    const capEnv = emitted[0];
    expect(capEnv.type).toBe('capability.invoke');
    expect(capEnv.sender).toBe('backend');
    expect(capEnv.recipient).toBe('electron');
    // invokeId travels via correlationId (TraceMetaSchema is strict — no room for extra fields)
    expect(capEnv.correlationId).toBe(invokeId);
    const payload = capEnv.payload as any;
    expect(payload.capability).toBe('browser');
    expect(payload.args).toEqual({ action: 'navigate', url: 'https://example.com' });
  });

  it('capability.result envelope resolves the corresponding inflight promise', async () => {
    const d = createDispatcher();
    const source = env({ id: 'src-2', correlationId: 'corr-2', traceMeta: {} });
    const emitted: UACSEnvelope[] = [];
    const invokeId = emitCapabilityInvoke({
      capability: 'media',
      args: { action: 'playMusic', source: 'song.mp3' },
      source,
      emit: (e) => emitted.push(e),
    });

    // Start awaiting — this replaces the inflight slot's resolve/reject with real callbacks
    const resultPromise = awaitCapabilityResult(invokeId);

    // Simulate renderer → backend: dispatch a capability.result envelope with the invokeId in correlationId
    await d.dispatch({
      id: 'result-1',
      type: 'capability.result',
      sender: 'electron',
      recipient: 'backend',
      timestamp: Date.now(),
      correlationId: invokeId,
      traceMeta: {},
      payload: { capability: 'media', success: true, result: { ok: true, mediaId: 'm-42' } },
    });

    const result = await resultPromise;
    expect(result).toEqual({ ok: true, mediaId: 'm-42' });
  });
});
