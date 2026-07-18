/**
 * Phase W4 — window-handler.test.ts
 *
 * 25+ 测试覆盖:
 * - getPreset: 4 种 preset 返回正确 windows 数
 * - window.create: kind='main' 走 askUser
 * - window.close: id='main-1' → gate deny
 * - window.preset: emit 4 个 window.create (focus)
 * - capability.invoke: IPC 转发 + whitelist + v2 fields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UACSEnvelope, WindowCreatePayload, WindowPreset } from './envelope.js';
import { SCENE_PRESETS, getPreset, PRESET_NAMES } from './window-presets.js';
import {
  registerWindowHandlers,
  _clearWindowAllowCacheForTest,
} from './window-handler.js';
import { evaluateWindowOp } from '../permission/gate.js';

const baseEnv = (overrides: Partial<UACSEnvelope> = {}): UACSEnvelope => ({
  id: 'env-1', type: 'chat.request', sender: 'backend', recipient: 'electron',
  timestamp: 1700000000000, correlationId: null, traceMeta: {},
  ...overrides,
} as UACSEnvelope);

interface FakeDeps {
  emit: ReturnType<typeof vi.fn>;
  ipcSend: ReturnType<typeof vi.fn>;
  askUser: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<FakeDeps> = {}): FakeDeps {
  return {
    emit: vi.fn(),
    ipcSend: vi.fn().mockResolvedValue({ ok: true }),
    askUser: vi.fn().mockResolvedValue('allow' as 'allow' | 'deny'),
    ...overrides,
  };
}

function makeDispatcher(deps: FakeDeps) {
  const handlers = new Map<string, (env: UACSEnvelope) => Promise<void> | void>();
  registerWindowHandlers(deps, (type, handler) => { handlers.set(type, handler); });
  return {
    dispatch: async (env: UACSEnvelope) => {
      const h = handlers.get(env.type);
      if (!h) throw new Error(`No handler for ${env.type}`);
      await h(env);
    },
    handlers,
  };
}

beforeEach(() => {
  _clearWindowAllowCacheForTest();
});

afterEach(() => {
  _clearWindowAllowCacheForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. SCENE_PRESETS — 4 种 preset windows 数
// ─────────────────────────────────────────────────────────────────────────────

describe('SCENE_PRESETS', () => {
  it('has exactly 4 presets', () => {
    expect(PRESET_NAMES).toHaveLength(4);
    expect(Object.keys(SCENE_PRESETS).sort()).toEqual([...PRESET_NAMES].sort());
  });

  it('developer: 3 windows (main + detail + floating)', () => {
    expect(getPreset('developer').windows).toHaveLength(3);
    expect(getPreset('developer').windows[0].kind).toBe('main');
  });

  it('analyst: 3 windows (main + detail + floating)', () => {
    expect(getPreset('analyst').windows).toHaveLength(3);
  });

  it('writer: 2 windows (main + detail)', () => {
    expect(getPreset('writer').windows).toHaveLength(2);
  });

  it('focus: 4 windows (main + 2 floating + notify)', () => {
    expect(getPreset('focus').windows).toHaveLength(4);
    const kinds = getPreset('focus').windows.map((w) => w.kind);
    expect(kinds).toContain('main');
    expect(kinds.filter((k) => k === 'floating')).toHaveLength(2);
    expect(kinds).toContain('notify');
  });

  it('every preset has a Chinese name', () => {
    expect(SCENE_PRESETS.developer.name).toBe('开发者模式');
    expect(SCENE_PRESETS.analyst.name).toBe('分析师模式');
    expect(SCENE_PRESETS.writer.name).toBe('写作模式');
    expect(SCENE_PRESETS.focus.name).toBe('专注模式');
  });

  it('getPreset returns a deep copy (mutating result does not affect source)', () => {
    const p1 = getPreset('developer');
    p1.windows[0].kind = 'floating';
    const p2 = getPreset('developer');
    expect(p2.windows[0].kind).toBe('main');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. window.create — kind='main' 走 askUser
// ─────────────────────────────────────────────────────────────────────────────

describe('window.create', () => {
  it('kind=main triggers askUser (first time)', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-c-1',
      type: 'window.create',
      payload: { kind: 'main', url: 'chat' },
    }));
    expect(deps.askUser).toHaveBeenCalledTimes(1);
    expect(deps.ipcSend).toHaveBeenCalledWith('window.dispatch', expect.objectContaining({
      type: 'window.create',
      payload: expect.objectContaining({ kind: 'main' }),
    }));
  });

  it('kind=main + user deny → no IPC, emit error', async () => {
    const deps = makeDeps({ askUser: vi.fn().mockResolvedValue('deny') });
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-c-2',
      type: 'window.create',
      payload: { kind: 'main' },
    }));
    expect(deps.ipcSend).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      payload: expect.objectContaining({ code: 'window.create.denied_by_user' }),
    }));
  });

  it('kind=main + second call within 5min → no askUser (cached)', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    const env1 = baseEnv({ id: 'w-c-3a', type: 'window.create', payload: { kind: 'main' } });
    const env2 = baseEnv({ id: 'w-c-3b', type: 'window.create', payload: { kind: 'main' } });
    await d.dispatch(env1);
    await d.dispatch(env2);
    expect(deps.askUser).toHaveBeenCalledTimes(1); // cached
    expect(deps.ipcSend).toHaveBeenCalledTimes(2);
  });

  it('requireConfirm=false → skip askUser even for main', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-c-4',
      type: 'window.create',
      payload: { kind: 'main', requireConfirm: false },
    }));
    expect(deps.askUser).not.toHaveBeenCalled();
    expect(deps.ipcSend).toHaveBeenCalled();
  });

  it('missing payload.kind → emit error envelope', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-c-5',
      type: 'window.create',
      payload: {} as any,
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'window.create.missing_kind' }),
    }));
    expect(deps.ipcSend).not.toHaveBeenCalled();
  });

  it('ipcSend throws → emit error', async () => {
    const deps = makeDeps({ ipcSend: vi.fn().mockRejectedValue(new Error('IPC down')) });
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-c-6',
      type: 'window.create',
      payload: { kind: 'floating', requireConfirm: false },
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'window.create.ipc_error' }),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. window.close — id='main-1' → gate deny (硬规则)
// ─────────────────────────────────────────────────────────────────────────────

describe('window.close', () => {
  it('id="main-1" → gate hard deny, no askUser', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-cl-1',
      type: 'window.close',
      payload: { id: 'main-1' },
    }));
    expect(deps.askUser).not.toHaveBeenCalled();
    expect(deps.ipcSend).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        code: 'window.close.denied_main',
        message: expect.stringContaining('主驾驶舱'),
      }),
    }));
  });

  it('id="main-2" → also denied (any main-* prefix)', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-cl-2',
      type: 'window.close',
      payload: { id: 'main-2' },
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'window.close.denied_main' }),
    }));
  });

  it('id="floating-1" + user allow → IPC forward', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-cl-3',
      type: 'window.close',
      payload: { id: 'floating-1' },
    }));
    expect(deps.askUser).toHaveBeenCalledTimes(1);
    expect(deps.ipcSend).toHaveBeenCalledWith('window.dispatch', expect.objectContaining({
      type: 'window.close',
      payload: { id: 'floating-1' },
    }));
  });

  it('id="detail-5" + user deny → no IPC, emit error', async () => {
    const deps = makeDeps({ askUser: vi.fn().mockResolvedValue('deny') });
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-cl-4',
      type: 'window.close',
      payload: { id: 'detail-5' },
    }));
    expect(deps.ipcSend).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'window.close.denied_by_user' }),
    }));
  });

  it('missing payload.id → emit error', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-cl-5',
      type: 'window.close',
      payload: {} as any,
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'window.close.missing_id' }),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. window.preset — emit 多个 window.create
// ─────────────────────────────────────────────────────────────────────────────

describe('window.preset', () => {
  it('preset="focus" emits 4 window.create envelopes', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-p-1',
      type: 'window.preset',
      payload: { preset: 'focus' },
    }));
    expect(deps.askUser).toHaveBeenCalledTimes(1);
    const createCalls = deps.emit.mock.calls.filter(([env]) => env.type === 'window.create');
    expect(createCalls).toHaveLength(4);
    // 每个 window.create 都带 requireConfirm=false (preset 用户已确认)
    for (const [env] of createCalls) {
      expect(env.payload.requireConfirm).toBe(false);
    }
  });

  it('preset="developer" emits 3 window.create envelopes', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-p-2',
      type: 'window.preset',
      payload: { preset: 'developer' },
    }));
    const createCalls = deps.emit.mock.calls.filter(([env]) => env.type === 'window.create');
    expect(createCalls).toHaveLength(3);
  });

  it('preset="writer" emits 2 window.create envelopes', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-p-3',
      type: 'window.preset',
      payload: { preset: 'writer' },
    }));
    const createCalls = deps.emit.mock.calls.filter(([env]) => env.type === 'window.create');
    expect(createCalls).toHaveLength(2);
  });

  it('preset + user deny → no emit', async () => {
    const deps = makeDeps({ askUser: vi.fn().mockResolvedValue('deny') });
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-p-4',
      type: 'window.preset',
      payload: { preset: 'analyst' },
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'window.preset.denied_by_user' }),
    }));
    const createCalls = deps.emit.mock.calls.filter(([env]) => env.type === 'window.create');
    expect(createCalls).toHaveLength(0);
  });

  it('missing payload.preset → emit error', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-p-5',
      type: 'window.preset',
      payload: {} as any,
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'window.preset.missing_preset' }),
    }));
  });

  it('preset emits correct kinds (focus: main + 2 floating + notify)', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-p-6',
      type: 'window.preset',
      payload: { preset: 'focus' },
    }));
    const createCalls = deps.emit.mock.calls.filter(([env]) => env.type === 'window.create');
    const kinds = createCalls.map(([env]) => (env.payload as WindowCreatePayload).kind);
    expect(kinds).toEqual(['main', 'floating', 'floating', 'notify']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. window.focus / resize / message — direct IPC, no askUser
// ─────────────────────────────────────────────────────────────────────────────

describe('window.focus / resize / message', () => {
  it('window.focus: IPC forward, no askUser', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-f-1',
      type: 'window.focus',
      payload: { id: 'detail-3' },
    }));
    expect(deps.askUser).not.toHaveBeenCalled();
    expect(deps.ipcSend).toHaveBeenCalledWith('window.dispatch', expect.objectContaining({
      type: 'window.focus',
      payload: { id: 'detail-3' },
    }));
  });

  it('window.resize: IPC forward with w/h', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-r-1',
      type: 'window.resize',
      payload: { id: 'detail-3', w: 1024, h: 768 },
    }));
    expect(deps.ipcSend).toHaveBeenCalledWith('window.dispatch', expect.objectContaining({
      type: 'window.resize',
      payload: { id: 'detail-3', w: 1024, h: 768 },
    }));
  });

  it('window.resize: missing w/h → emit error', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-r-2',
      type: 'window.resize',
      payload: { id: 'detail-3' } as any,
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'window.resize.missing_fields' }),
    }));
  });

  it('window.message: from/to forwarded', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'w-m-1',
      type: 'window.message',
      payload: { from: 'detail-1', to: 'main-1', message: { ping: true } },
    }));
    expect(deps.ipcSend).toHaveBeenCalledWith('window.dispatch', expect.objectContaining({
      type: 'window.message',
      payload: { from: 'detail-1', to: 'main-1', message: { ping: true } },
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. capability.invoke v2 — whitelist + 转发 + v2 fields
// ─────────────────────────────────────────────────────────────────────────────

describe('capability.invoke v2', () => {
  it('whitelisted capability (browser) forwards IPC + emits capability.result', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'c-i-1',
      correlationId: 'inv-1',
      type: 'capability.invoke',
      payload: {
        capability: 'browser',
        args: { action: 'navigate', url: 'https://example.com' },
      },
    }));
    expect(deps.ipcSend).toHaveBeenCalledWith('capability.dispatch', expect.objectContaining({
      capability: 'browser',
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'capability.result',
      payload: expect.objectContaining({
        capability: 'browser',
        success: true,
      }),
    }));
  });

  it('non-whitelisted capability → emit error, no IPC', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'c-i-2',
      type: 'capability.invoke',
      payload: {
        capability: 'system_shell' as any, // bypass schema for test
        args: {},
      },
    }));
    expect(deps.ipcSend).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ code: 'capability.invoke.not_whitelisted' }),
    }));
  });

  it('v2 fields (timeoutMs/priority/preload) are forwarded as-is', async () => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'c-i-3',
      type: 'capability.invoke',
      payload: {
        capability: 'media',
        args: { action: 'play', source: 'song.mp3' },
        version: 2,
        timeoutMs: 5000,
        priority: 'high',
        preload: '/scripts/media-helper.js',
      },
    }));
    expect(deps.ipcSend).toHaveBeenCalledWith('capability.dispatch', expect.objectContaining({
      version: 2,
      timeoutMs: 5000,
      priority: 'high',
      preload: '/scripts/media-helper.js',
    }));
  });

  it('fallback capability kicks in when primary fails', async () => {
    const deps = makeDeps({
      ipcSend: vi.fn()
        .mockRejectedValueOnce(new Error('primary fail'))
        .mockResolvedValueOnce({ ok: true, source: 'fallback-result' }),
    });
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'c-i-4',
      type: 'capability.invoke',
      payload: {
        capability: 'map',
        args: { city: 'Beijing' },
        fallback: 'browser',
      },
    }));
    expect(deps.ipcSend).toHaveBeenCalledTimes(2);
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        capability: 'browser', // fallback was used
        success: true,
      }),
    }));
  });

  it('both primary + fallback fail → emit capability.result with success=false', async () => {
    const deps = makeDeps({
      ipcSend: vi.fn().mockRejectedValue(new Error('all fail')),
    });
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: 'c-i-5',
      type: 'capability.invoke',
      payload: {
        capability: 'map',
        args: { city: 'Beijing' },
        fallback: 'browser',
      },
    }));
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        capability: 'map',
        success: false,
      }),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. evaluateWindowOp 集成测试
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateWindowOp (integration)', () => {
  it('close main → deny', () => {
    expect(evaluateWindowOp('close', { kind: 'main' })).toBe('deny');
  });

  it('close floating/detail/notify → ask', () => {
    expect(evaluateWindowOp('close', { kind: 'floating' })).toBe('ask');
    expect(evaluateWindowOp('close', { kind: 'detail' })).toBe('ask');
    expect(evaluateWindowOp('close', { kind: 'notify' })).toBe('ask');
  });

  it('focus/resize/message → allow', () => {
    expect(evaluateWindowOp('focus')).toBe('allow');
    expect(evaluateWindowOp('resize')).toBe('allow');
    expect(evaluateWindowOp('message')).toBe('allow');
  });

  it('preset → ask', () => {
    expect(evaluateWindowOp('preset')).toBe('ask');
  });

  it('bypassConfirm=true → allow', () => {
    expect(evaluateWindowOp('create', { kind: 'main', bypassConfirm: true })).toBe('allow');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. enumerate all 4 preset types compile + dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe('enumerate all 4 preset types via PRESET_NAMES', () => {
  it.each(PRESET_NAMES as WindowPreset[])('%s dispatches without error', async (preset) => {
    const deps = makeDeps();
    const d = makeDispatcher(deps);
    await d.dispatch(baseEnv({
      id: `w-enum-${preset}`,
      type: 'window.preset',
      payload: { preset },
    }));
    const createCalls = deps.emit.mock.calls.filter(([env]) => env.type === 'window.create');
    expect(createCalls.length).toBe(getPreset(preset).windows.length);
  });
});