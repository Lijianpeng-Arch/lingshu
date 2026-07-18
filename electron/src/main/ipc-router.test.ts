/**
 * IpcRouter 单元测试 — Phase W1.2
 *
 * IpcRouter 通过静态 import 把 WindowPool 拉进来,
 * 所以必须在模块加载前用 vi.hoisted + vi.mock 把 electron 替换掉。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============== hoisted mocks ==============
const { MockBrowserWindowRef, MockWebContentsViewRef, MockWebContentsRef } = vi.hoisted(() => {
  class WebContents {
    send = vi.fn();
    setWindowOpenHandler = vi.fn();
    loadURL = vi.fn(async (_url: string) => {});
    capturePage = vi.fn(async () => ({
      toPNG: () => Buffer.from('fake'),
      getSize: () => ({ width: 800, height: 600 }),
    }));
    executeJavaScript = vi.fn(async () => true);
    close = vi.fn();
    isDestroyed = vi.fn(() => false);
    getURL = vi.fn(() => 'about:blank');
    getTitle = vi.fn(() => '');
    on = vi.fn();
  }

  class BW {
    static instances: BW[] = [];
    static id_counter = 0;
    id: string;
    webContents = new WebContents();
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    private _destroyed = false;
    private _listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    show = vi.fn();
    focus = vi.fn();
    close = vi.fn(() => {
      this._destroyed = true;
      const arr = this._listeners.get('closed') ?? [];
      for (const fn of arr) fn();
    });
    setSize = vi.fn();
    loadURL = vi.fn();
    loadFile = vi.fn();
    isDestroyed = vi.fn(() => this._destroyed);
    on(event: string, listener: (...args: unknown[]) => void) {
      const arr = this._listeners.get(event) ?? [];
      arr.push(listener);
      this._listeners.set(event, arr);
    }
    once(event: string, listener: (...args: unknown[]) => void) {
      this.on(event, listener);
    }
    constructor(public options: any = {}) {
      this.id = `mock-bw-${++BW.id_counter}`;
      BW.instances.push(this);
    }
  }

  class WCV {
    static instances: WCV[] = [];
    static id_counter = 0;
    id: string;
    webContents = new WebContents();
    setBounds = vi.fn();
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 }));
    constructor(public options: any = {}) {
      this.id = `mock-wcv-${++WCV.id_counter}`;
      WCV.instances.push(this);
    }
  }

  return {
    MockBrowserWindowRef: BW,
    MockWebContentsViewRef: WCV,
    MockWebContentsRef: WebContents,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindowRef,
  WebContentsView: MockWebContentsViewRef,
  app: {
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    quit: vi.fn(),
    getVersion: vi.fn(() => '0.1.0'),
  },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  net: { fetch: vi.fn() },
  dialog: {},
}));

import { IpcRouter, getIpcRouter, resetIpcRouter } from './ipc-router.js';
import { resetWindowPool } from './window-pool.js';

const BW = MockBrowserWindowRef;
const WCV = MockWebContentsViewRef;

describe('IpcRouter', () => {
  beforeEach(() => {
    BW.instances = [];
    BW.id_counter = 0;
    WCV.instances = [];
    WCV.id_counter = 0;
    resetIpcRouter();
    resetWindowPool();
    vi.clearAllMocks();
  });

  it('getIpcRouter returns singleton', () => {
    const a = getIpcRouter();
    const b = getIpcRouter();
    expect(a).toBe(b);
  });

  it('routes window.create to WindowPool', async () => {
    const router = getIpcRouter();
    const result = await router.route({
      id: 'env-1', type: 'window.create', sender: 'backend', recipient: 'electron',
      timestamp: Date.now(), correlationId: null, traceMeta: {},
      payload: { kind: 'main', w: 800, h: 600 },
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data).toHaveProperty('id');
  });

  it('routes capability.invoke(browser) — unimplemented in MVP', async () => {
    const router = getIpcRouter();
    const result = await router.route({
      id: 'env-2', type: 'capability.invoke', sender: 'backend', recipient: 'electron',
      timestamp: Date.now(), correlationId: 'cap-1', traceMeta: {},
      payload: { capability: 'browser', args: { action: 'navigate', url: 'https://example.com' } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown capability');
  });

  it('routes capability.invoke(map) — unimplemented in MVP', async () => {
    const router = getIpcRouter();
    const result = await router.route({
      id: 'env-3', type: 'capability.invoke', sender: 'backend', recipient: 'electron',
      timestamp: Date.now(), correlationId: 'cap-3', traceMeta: {},
      payload: { capability: 'map', args: { city: '北京' } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown capability');
  });

  it('routes capability.invoke(media) — unimplemented in MVP', async () => {
    const router = getIpcRouter();
    const result = await router.route({
      id: 'env-4', type: 'capability.invoke', sender: 'backend', recipient: 'electron',
      timestamp: Date.now(), correlationId: 'cap-4', traceMeta: {},
      payload: { capability: 'media', args: { action: 'play', source: 'https://example.com/song.mp3' } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown capability');
  });

  it('rejects unknown capability', async () => {
    const router = getIpcRouter();
    const result = await router.route({
      id: 'env-5', type: 'capability.invoke', sender: 'backend', recipient: 'electron',
      timestamp: Date.now(), correlationId: 'cap-5', traceMeta: {},
      payload: { capability: 'unknown', args: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown capability');
  });

  it('rejects unknown envelope type', async () => {
    const router = getIpcRouter();
    const result = await router.route({
      id: 'env-6', type: 'window.message', sender: 'backend', recipient: 'electron',
      timestamp: Date.now(), correlationId: null, traceMeta: {},
      payload: { from: 'a', to: 'b', message: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not implemented');
  });
});
