import { describe, it, expect } from 'vitest';
import { emitCapabilityInvoke } from '../uacs/dispatcher.js';
import type { UACSEnvelope } from '../uacs/envelope.js';

/**
 * Dispatcher contract test for emitCapabilityInvoke.
 *
 * The helper has only one job: mint a `cap-*` invokeId, emit a
 * `capability.invoke` envelope (carrying the invokeId in `correlationId`),
 * and return the invokeId so chat-handler can `awaitCapabilityResult(invokeId)`.
 *
 * The chat-handler integration test (in chat-handler.test.ts, "Phase C.4 —
 * executeMockTool capability routing") pins the end-to-end behavior including
 * await blocking and result feeding.
 */
describe('uacs/dispatcher — emitCapabilityInvoke contract', () => {
  it('returns invokeId matching /^cap-/ and emits a capability.invoke envelope', () => {
    const emitted: UACSEnvelope[] = [];
    const source: UACSEnvelope = {
      id: 'env-source',
      type: 'chat.request',
      sender: 'electron',
      recipient: 'backend',
      timestamp: Date.now(),
      correlationId: null,
      traceMeta: {},
      payload: { messages: [{ role: 'user', content: '广州地图' }], sessionId: 'session-1' },
    };
    const invokeId = emitCapabilityInvoke({
      capability: 'map',
      args: { city: '广州' },
      source,
      emit: (env) => { emitted.push(env); },
    });
    expect(invokeId).toMatch(/^cap-/);
    expect(emitted).toHaveLength(1);

    const env = emitted[0]!;
    expect(env.type).toBe('capability.invoke');
    expect(env.correlationId).toBe(invokeId);
    // chat-handler reads these two fields when feeding the result back to the LLM
    expect(env.payload).toBeDefined();
    if (env.type === 'capability.invoke') {
      expect(env.payload?.capability).toBe('map');
      expect(env.payload?.args).toEqual({ city: '广州' });
    }
    // sender flips to backend so renderer knows to dispatch
    expect(env.sender).toBe('backend');
    expect(env.recipient).toBe('electron');
  });
});