/**
 * WindowPool 单元测试 — Phase A.2
 *
 * 用手写 minimal mock 替换 BrowserWindow。
 * 注意: vi.mock 工厂会被 hoist 到文件顶部,所以工厂内只能引用自身声明的变量,
 * 不能引用模块顶部的 class。改用 mockImplementation + 模块加载后注入。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============== MockBrowserWindow 类 (放在 vi.mock 外面,但只用于内部) ==============
class MockWebContents {
  send = vi.fn();
  setWindowOpenHandler = vi.fn();
}

class MockBrowserWindow {
  static instances: MockBrowserWindow[] = [];
  static id_counter = 0;
  id: string;
  webContents = new MockWebContents();
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

  constructor(public options: any) {
    this.id = `mock-bw-${++MockBrowserWindow.id_counter}`;
    MockBrowserWindow.instances.push(this);
    // ready-to-show 异步触发
    queueMicrotask(() => {
      const arr = this._listeners.get('ready-to-show') ?? [];
      for (const fn of arr) fn();
    });
  }
}

// ============== 用 vi.mock 在模块加载前替换 electron ==============
// 关键:factory 函数必须是纯字面量,不能引用外部变量。
// 把 MockBrowserWindow 暴露在 vi.hoisted 里,这样所有 vi.mock/import 都能用。
const { MockBrowserWindowRef } = vi.hoisted(() => {
  // 注意:hoisted 函数也在顶部执行,所以这里只能用最简单的 class 声明。
  class WebContents {
    send = vi.fn();
    setWindowOpenHandler = vi.fn();
  }
  class BW {
    static instances: BW[] = [];
    static id_counter = 0;
    id: string;
    webContents = new WebContents();
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
    constructor(public options: any) {
      this.id = `mock-bw-${++BW.id_counter}`;
      BW.instances.push(this);
      queueMicrotask(() => {
        const arr = this._listeners.get('ready-to-show') ?? [];
        for (const fn of arr) fn();
      });
    }
  }
  return { MockBrowserWindowRef: BW };
});

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindowRef,
  app: {
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    quit: vi.fn(),
    getVersion: vi.fn(() => '0.1.0'),
  },
  shell: {
    openExternal: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  net: { fetch: vi.fn() },
  dialog: {},
}));

// ============== 真实测试 ==============
// 必须 dynamic import,在 vi.mock 设置好之后再加载被测模块。
// 但 vitest 的 vi.mock 在 import 时就生效,所以静态 import 也可以。
import { WindowPool, getWindowPool, resetWindowPool } from './window-pool.js';

// 拿到被测代码实际用的 BrowserWindow(就是 mock)
const BW = MockBrowserWindowRef;

describe('WindowPool — 4 种窗口类型', () => {
  beforeEach(() => {
    BW.instances = [];
    BW.id_counter = 0;
    resetWindowPool();
    vi.clearAllMocks();
  });

  it('create 生成 id + 存入 Map', () => {
    const pool = new WindowPool();
    const id1 = pool.create({ kind: 'main' });
    const id2 = pool.create({ kind: 'floating' });
    const id3 = pool.create({ kind: 'detail' });
    const id4 = pool.create({ kind: 'notify' });

    // counter 是 pool-instance 级,每创建一个窗口 +1
    expect(id1).toBe('main-1');
    expect(id2).toBe('floating-2');
    expect(id3).toBe('detail-3');
    expect(id4).toBe('notify-4');

    expect(pool.size()).toBe(4);
    expect(BW.instances).toHaveLength(4);

    // 4 种 kind 的默认值
    const mainOpts = BW.instances[0]!.options;
    const floatOpts = BW.instances[1]!.options;
    const detailOpts = BW.instances[2]!.options;
    const notifyOpts = BW.instances[3]!.options;
    expect(mainOpts.width).toBe(1200);
    expect(mainOpts.height).toBe(800);
    expect(mainOpts.alwaysOnTop).toBe(false);
    expect(floatOpts.width).toBe(400);
    expect(floatOpts.height).toBe(300);
    expect(floatOpts.alwaysOnTop).toBe(true);
    expect(floatOpts.skipTaskbar).toBe(true);
    expect(detailOpts.width).toBe(800);
    expect(detailOpts.height).toBe(600);
    expect(notifyOpts.frame).toBe(false);
    expect(notifyOpts.alwaysOnTop).toBe(true);

    // url 走 hash 路由
    pool.create({ kind: 'detail', url: 'inspect/abc' });
    const detailWin = BW.instances[4]!;
    expect(detailWin.loadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ hash: '/inspect/abc' }),
    );

    pool.closeAll();
  });

  it('close 从 Map 删除 + 调 win.close', () => {
    const pool = new WindowPool();
    const id = pool.create({ kind: 'main' });
    const bw = BW.instances[0]!;
    expect(pool.size()).toBe(1);

    pool.close(id);

    expect(bw.close).toHaveBeenCalled();
    expect(pool.size()).toBe(0);
    expect(pool.get(id)).toBeUndefined();

    // 重复 close 不报错
    expect(() => pool.close(id)).not.toThrow();

    pool.closeAll();
  });

  it('focus 调 win.focus + show', () => {
    const pool = new WindowPool();
    const id = pool.create({ kind: 'floating' });
    const bw = BW.instances[0]!;

    pool.focus(id);

    expect(bw.show).toHaveBeenCalled();
    expect(bw.focus).toHaveBeenCalled();

    expect(() => pool.focus('nonexistent')).not.toThrow();

    pool.closeAll();
  });

  it('resize 调 win.setSize', () => {
    const pool = new WindowPool();
    const id = pool.create({ kind: 'detail', width: 800, height: 600 });
    const bw = BW.instances[0]!;

    pool.resize(id, 1024, 768);

    expect(bw.setSize).toHaveBeenCalledWith(1024, 768);

    expect(() => pool.resize('nonexistent', 100, 100)).not.toThrow();

    pool.closeAll();
  });

  it('broadcast 遍历所有窗口调 win.webContents.send', () => {
    const pool = new WindowPool();
    pool.create({ kind: 'main' });
    pool.create({ kind: 'floating', url: 'mini' });
    pool.create({ kind: 'notify' });

    const [bw1, bw2, bw3] = BW.instances as any[];

    pool.broadcast('skill:update', { id: 's-1', version: '2' });

    expect(bw1!.webContents.send).toHaveBeenCalledWith('skill:update', { id: 's-1', version: '2' });
    expect(bw2!.webContents.send).toHaveBeenCalledWith('skill:update', { id: 's-1', version: '2' });
    expect(bw3!.webContents.send).toHaveBeenCalledWith('skill:update', { id: 's-1', version: '2' });

    // list 返回精简信息
    const list = pool.list();
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ kind: 'main', url: '' });
    expect(list[1]).toMatchObject({ kind: 'floating', url: 'mini' });
    expect(list[2]).toMatchObject({ kind: 'notify' });
    expect((list[0] as any).win).toBeUndefined();

    pool.closeAll();
    expect(pool.size()).toBe(0);
  });
});

describe('WindowPool — 单例', () => {
  beforeEach(() => {
    BW.instances = [];
    BW.id_counter = 0;
    resetWindowPool();
  });

  it('getWindowPool 返回同一实例,resetWindowPool 重置', () => {
    const a = getWindowPool();
    const b = getWindowPool();
    expect(a).toBe(b);

    a.create({ kind: 'main' });
    expect(a.size()).toBe(1);

    resetWindowPool();
    const c = getWindowPool();
    expect(c).not.toBe(a);
    expect(c.size()).toBe(0);

    resetWindowPool();
  });
});

// 防止 lint 报 unused
void MockBrowserWindow;