import { describe, it, expect } from 'vitest';
import {
  UACSEnvelopeSchema,
  AcuiShowPayloadSchema,
  AcuiHidePayloadSchema,
  ChatRequestPayloadSchema,
  ChatResponsePayloadSchema,
  ChatDeltaPayloadSchema,
  ChatDonePayloadSchema,
  ProbeRequestPayloadSchema,
  ProbeResponsePayloadSchema,
  ErrorPayloadSchema,
  WindowCreatePayloadSchema,
  WindowClosePayloadSchema,
  WindowFocusPayloadSchema,
  WindowResizePayloadSchema,
  WindowMessagePayloadSchema,
  CapabilityInvokePayloadSchema,
  CapabilityResultPayloadSchema,
  AwarenessUpdatePayloadSchema,
  AwarenessSnapshotPayloadSchema,
} from './envelope.js';

describe('UACSEnvelopeSchema', () => {
  const base = {
    id: 'env-1', type: 'chat.request' as const, sender: 'electron' as const,
    recipient: 'backend' as const, timestamp: 1700000000000, correlationId: null,
    traceMeta: { sessionId: 'sess-1' },
  };
  it('accepts valid envelope', () => {
    expect(UACSEnvelopeSchema.parse(base).id).toBe('env-1');
  });
  it('rejects unknown type', () => {
    expect(() => UACSEnvelopeSchema.parse({ ...base, type: 'unknown.type' })).toThrow();
  });
  it('rejects missing id', () => {
    const { id, ...rest } = base;
    expect(() => UACSEnvelopeSchema.parse(rest)).toThrow();
  });
  it('accepts payload matching type', () => {
    const env = UACSEnvelopeSchema.parse({
      ...base, type: 'chat.request',
      payload: { messages: [{ role: 'user', content: 'hi' }], sessionId: 'sess-1' },
    });
    expect(env.payload).toBeDefined();
  });
});

describe('Payload schemas', () => {
  it('acui.show accepts valid payload', () => {
    const p = AcuiShowPayloadSchema.parse({
      component: 'SecurityConfirmCard', props: { title: 'Delete?' },
      hint: { placement: 'center', modal: true },
    });
    expect(p.component).toBe('SecurityConfirmCard');
  });
  it('acui.show rejects invalid placement', () => {
    expect(() => AcuiShowPayloadSchema.parse({
      component: 'X', props: {}, hint: { placement: 'invalid' },
    })).toThrow();
  });
  it('acui.hide accepts componentId', () => {
    expect(AcuiHidePayloadSchema.parse({ componentId: 'card-1' }).componentId).toBe('card-1');
  });
  it('chat.request requires messages', () => {
    expect(() => ChatRequestPayloadSchema.parse({})).toThrow();
    expect(ChatRequestPayloadSchema.parse({
      messages: [{ role: 'user', content: 'hi' }], sessionId: 's1',
    }).messages).toHaveLength(1);
  });
  it('chat.response validates shape', () => {
    expect(ChatResponsePayloadSchema.parse({
      messageId: 'm-1', content: 'hi', done: true,
    }).done).toBe(true);
  });
  it('probe.request validates', () => {
    expect(ProbeRequestPayloadSchema.parse({ providerName: 'd', apiKey: 'k' }).providerName).toBe('d');
  });
  it('probe.response validates', () => {
    expect(ProbeResponsePayloadSchema.parse({
      providerName: 'd', ok: true, capabilities: ['chat'], model: 'm', latencyMs: 200,
    }).ok).toBe(true);
  });
  it('error validates', () => {
    expect(ErrorPayloadSchema.parse({
      code: 'AUTH', message: 'bad key', recoverable: false,
    }).code).toBe('AUTH');
  });
});

describe('ChatDeltaPayloadSchema', () => {
  it('accepts minimal { messageId, delta }', () => {
    const p = ChatDeltaPayloadSchema.parse({ messageId: 'm-1', delta: '你' });
    expect(p.delta).toBe('你');
  });
  it('accepts optional sessionId', () => {
    const p = ChatDeltaPayloadSchema.parse({ messageId: 'm-1', delta: '好', sessionId: 's1' });
    expect(p.sessionId).toBe('s1');
  });
  it('rejects missing messageId', () => {
    expect(() => ChatDeltaPayloadSchema.parse({ delta: 'x' })).toThrow();
  });
});

describe('ChatDonePayloadSchema', () => {
  it('accepts { messageId }', () => {
    const p = ChatDonePayloadSchema.parse({ messageId: 'm-1' });
    expect(p.messageId).toBe('m-1');
  });
  it('accepts finishReason null and string', () => {
    expect(ChatDonePayloadSchema.parse({ messageId:'m', finishReason: null }).finishReason).toBeNull();
    expect(ChatDonePayloadSchema.parse({ messageId:'m', finishReason: 'stop' }).finishReason).toBe('stop');
  });
});

describe('UACSEnvelopeSchema with chat.delta / chat.done', () => {
  const base = {
    id:'e', sender:'backend' as const, recipient:'electron' as const,
    timestamp:1, correlationId:'c', traceMeta: {},
  };
  it('accepts chat.delta envelope', () => {
    const env = UACSEnvelopeSchema.parse({ ...base, type:'chat.delta', payload: { messageId:'m', delta:'x' } });
    expect(env.type).toBe('chat.delta');
  });
  it('accepts chat.done envelope', () => {
    const env = UACSEnvelopeSchema.parse({ ...base, type:'chat.done', payload: { messageId:'m' } });
    expect(env.type).toBe('chat.done');
  });
});

// ========== Phase A.1: window.* / capability.* / awareness.* ==========

describe('WindowCreatePayloadSchema', () => {
  it('accepts valid window.create payload', () => {
    const p = WindowCreatePayloadSchema.parse({ kind: 'floating', url: 'app://detail/42', w: 400, h: 300, title: 'Detail' });
    expect(p.kind).toBe('floating');
    expect(p.w).toBe(400);
  });
  it('rejects invalid kind', () => {
    expect(() => WindowCreatePayloadSchema.parse({ kind: 'modal' })).toThrow();
  });
  it('round-trips inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e1', type: 'window.create', sender: 'soul', recipient: 'electron',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { kind: 'main', title: 'Home' },
    });
    expect(env.type).toBe('window.create');
    expect((env.payload as any)?.kind).toBe('main');
  });
});

describe('WindowClosePayloadSchema', () => {
  it('accepts { id }', () => {
    const p = WindowClosePayloadSchema.parse({ id: 'win-1' });
    expect(p.id).toBe('win-1');
  });
  it('rejects empty id', () => {
    expect(() => WindowClosePayloadSchema.parse({ id: '' })).toThrow();
  });
  it('round-trips inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e2', type: 'window.close', sender: 'soul', recipient: 'electron',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { id: 'win-2' },
    });
    expect(env.type).toBe('window.close');
    expect((env.payload as { id: string } | undefined)?.id).toBe('win-2');
  });
});

describe('WindowFocusPayloadSchema', () => {
  it('accepts { id }', () => {
    const p = WindowFocusPayloadSchema.parse({ id: 'win-3' });
    expect(p.id).toBe('win-3');
  });
  it('rejects missing id', () => {
    expect(() => WindowFocusPayloadSchema.parse({})).toThrow();
  });
  it('round-trips inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e3', type: 'window.focus', sender: 'soul', recipient: 'electron',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { id: 'win-3' },
    });
    expect(env.type).toBe('window.focus');
  });
});

describe('WindowResizePayloadSchema', () => {
  it('accepts { id, w, h }', () => {
    const p = WindowResizePayloadSchema.parse({ id: 'win-4', w: 800, h: 600 });
    expect(p.w).toBe(800);
  });
  it('rejects non-positive dimensions', () => {
    expect(() => WindowResizePayloadSchema.parse({ id: 'w', w: 0, h: 100 })).toThrow();
    expect(() => WindowResizePayloadSchema.parse({ id: 'w', w: 100, h: -1 })).toThrow();
  });
  it('round-trips inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e4', type: 'window.resize', sender: 'soul', recipient: 'electron',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { id: 'win-4', w: 1024, h: 768 },
    });
    expect(env.type).toBe('window.resize');
    expect((env.payload as { w: number } | undefined)?.w).toBe(1024);
  });
});

describe('WindowMessagePayloadSchema', () => {
  it('accepts { from, to, message }', () => {
    const p = WindowMessagePayloadSchema.parse({ from: 'win-a', to: 'win-b', message: { text: 'hi' } });
    expect(p.from).toBe('win-a');
    expect((p.message as { text: string }).text).toBe('hi');
  });
  it('rejects missing to', () => {
    expect(() => WindowMessagePayloadSchema.parse({ from: 'a', message: 'x' })).toThrow();
  });
  it('round-trips inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e5', type: 'window.message', sender: 'electron', recipient: 'electron',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { from: 'main', to: 'detail', message: 'refresh' },
    });
    expect(env.type).toBe('window.message');
  });
});

describe('CapabilityInvokePayloadSchema', () => {
  it('accepts { capability, args }', () => {
    const p = CapabilityInvokePayloadSchema.parse({ capability: 'browser', args: { url: 'https://x' } });
    expect(p.capability).toBe('browser');
  });
  it('rejects unknown capability', () => {
    expect(() => CapabilityInvokePayloadSchema.parse({ capability: 'teleport', args: {} })).toThrow();
  });
  it('round-trips inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e6', type: 'capability.invoke', sender: 'soul', recipient: 'tool',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { capability: 'map', args: { query: '北京' } },
    });
    expect(env.type).toBe('capability.invoke');
    expect((env.payload as { capability: string } | undefined)?.capability).toBe('map');
  });
});

describe('CapabilityResultPayloadSchema', () => {
  it('accepts success with result', () => {
    const p = CapabilityResultPayloadSchema.parse({ capability: 'browser', success: true, result: { html: '...' } });
    expect(p.success).toBe(true);
  });
  it('rejects empty capability', () => {
    expect(() => CapabilityResultPayloadSchema.parse({ capability: '', success: true })).toThrow();
  });
  it('round-trips failure with error inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e7', type: 'capability.result', sender: 'tool', recipient: 'soul',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { capability: 'media', success: false, error: 'permission denied' },
    });
    expect(env.type).toBe('capability.result');
    expect((env.payload as { error: string } | undefined)?.error).toBe('permission denied');
  });
});

describe('AwarenessUpdatePayloadSchema', () => {
  it('accepts { kind, data }', () => {
    const p = AwarenessUpdatePayloadSchema.parse({ kind: 'emotion', data: { valence: 0.8 } });
    expect(p.kind).toBe('emotion');
  });
  it('rejects invalid kind', () => {
    expect(() => AwarenessUpdatePayloadSchema.parse({ kind: 'mood', data: {} })).toThrow();
  });
  it('round-trips inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e8', type: 'awareness.update', sender: 'soul', recipient: 'electron',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { kind: 'task', data: { id: 't-1', progress: 0.5 } },
    });
    expect(env.type).toBe('awareness.update');
    expect((env.payload as { kind: string } | undefined)?.kind).toBe('task');
  });
});

describe('AwarenessSnapshotPayloadSchema', () => {
  it('accepts full snapshot', () => {
    const p = AwarenessSnapshotPayloadSchema.parse({
      tasks: [{ id: 't1', title: 'do thing', status: 'running' }],
      thoughts: [{ id: 'th1', content: 'hmm', priority: 'high' }],
      status: { mode: 'idle', uptime: 120, activeTasks: 1 },
      emotion: 'curious',
    });
    expect(p.tasks).toHaveLength(1);
    expect(p.status.uptime).toBe(120);
  });
  it('rejects invalid task status', () => {
    expect(() => AwarenessSnapshotPayloadSchema.parse({
      tasks: [{ id: 't', title: 'x', status: 'maybe' }],
      thoughts: [], status: { mode: 'idle', uptime: 0, activeTasks: 0 }, emotion: '',
    })).toThrow();
  });
  it('round-trips empty snapshot inside envelope', () => {
    const env = UACSEnvelopeSchema.parse({
      id: 'e9', type: 'awareness.snapshot', sender: 'soul', recipient: 'electron',
      timestamp: 1, correlationId: null, traceMeta: {},
      payload: { tasks: [], thoughts: [], status: { mode: 'boot', uptime: 0, activeTasks: 0 }, emotion: 'neutral' },
    });
    expect(env.type).toBe('awareness.snapshot');
    expect((env.payload as { emotion: string } | undefined)?.emotion).toBe('neutral');
  });
});