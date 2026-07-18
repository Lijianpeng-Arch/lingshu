/**
 * WindowPool — 主进程统一管理 7 种窗口类型 (2026-07-17 W3)
 *
 * 7 种 kind:
 *   W1 (4 旧, 保留):
 *   - main:     主驾驶舱 (1200x800, 标题栏)
 *   - floating: 浮窗 (400x300, 始终置顶, 不在任务栏)
 *   - detail:   详情面板 (800x600, 常规窗口)
 *   - notify:   通知 (360x80, 始终置顶, 无边框, 不在任务栏)
 *
 *   W3 (3 新,本次新增):
 *   - scene:    全屏布局组容器 — 多窗口协同 (1920x1080, 无边框)
 *   - dock:     240×800 侧边栏停靠 — 固定一边常驻
 *   - popover:  锚定气泡 — 跟随某组件 (320x120, 始终置顶)
 *
 * 设计原则 (沿用 W1):
 *   - 单例 (getWindowPool/resetWindowPool) — 方便测试
 *   - 每个窗口一个唯一 id (kind-counter)
 *   - url 通过 hash 路由 (/<url>) 传给 renderer,renderer 自己解析
 *   - broadcast: 主进程向所有窗口广播事件 (例如 skill:update)
 */

import { BrowserWindow, app, shell, type BrowserWindowConstructorOptions } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type WindowKind =
  | 'main'
  | 'floating'
  | 'detail'
  | 'notify'
  | 'scene'
  | 'dock'
  | 'popover';

export interface WindowCreateOpts {
  kind: WindowKind;
  /** 不传自动生成 "kind-N" */
  id?: string;
  /** detail/floating 用,renderer 通过 hash 路由区分页面 */
  url?: string;
  width?: number;
  height?: number;
  title?: string;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  resizable?: boolean;
  /** notify 默认 false (无边框) */
  frame?: boolean;
  /** dock 的边 (left/right), popover 暂未使用 */
  dockSide?: 'left' | 'right';
}

export interface WindowInfo {
  id: string;
  kind: WindowKind;
  win: BrowserWindow;
  url: string;
  createdAt: number;
}

/** 计算 __dirname,兼容测试环境 (vitest 可能没有 file:// import.meta.url) */
function resolveDirname(): string {
  try {
    return fileURLToPath(new URL('.', import.meta.url));
  } catch {
    // 测试 fallback: 走到当前工作目录
    return process.cwd();
  }
}

/** 7 种 kind 的默认尺寸 + 标志 */
function getDefaults(
  kind: WindowKind,
): Required<Pick<BrowserWindowConstructorOptions, 'width' | 'height' | 'alwaysOnTop' | 'skipTaskbar' | 'resizable' | 'frame'>> {
  switch (kind) {
    case 'main':
      return { width: 1200, height: 800, alwaysOnTop: false, skipTaskbar: false, resizable: true, frame: true };
    case 'floating':
      return { width: 400, height: 300, alwaysOnTop: true, skipTaskbar: true, resizable: true, frame: true };
    case 'detail':
      return { width: 800, height: 600, alwaysOnTop: false, skipTaskbar: false, resizable: true, frame: true };
    case 'notify':
      return { width: 360, height: 80, alwaysOnTop: true, skipTaskbar: true, resizable: false, frame: false };
    case 'scene':
      // 全屏布局组容器 — 多窗口协同场景
      return { width: 1920, height: 1080, alwaysOnTop: false, skipTaskbar: false, resizable: true, frame: true };
    case 'dock':
      // 240×800 侧边栏停靠
      return { width: 240, height: 800, alwaysOnTop: false, skipTaskbar: false, resizable: false, frame: true };
    case 'popover':
      // 锚定气泡, 小尺寸始终置顶无边框
      return { width: 320, height: 120, alwaysOnTop: true, skipTaskbar: true, resizable: false, frame: false };
  }
}

export class WindowPool {
  private windows = new Map<string, WindowInfo>();
  private counter = 0;

  /** 创建窗口,返回 id */
  create(opts: WindowCreateOpts): string {
    const id = opts.id ?? `${opts.kind}-${++this.counter}`;
    const defaults = getDefaults(opts.kind);

    // 延迟解析路径(测试环境下 import.meta.url 可能不是 file://)
    const dirname = resolveDirname();
    const indexPath = join(dirname, '..', '..', 'dist', 'renderer', 'index.html');
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    const preloadPath = join(dirname, '../preload/preload.js');

    const win = new BrowserWindow({
      width: opts.width ?? defaults.width,
      height: opts.height ?? defaults.height,
      minWidth: 400,
      minHeight: 200,
      show: false,
      backgroundColor: '#0a0e1a',
      titleBarStyle: opts.kind === 'main' ? 'hidden' : 'default',
      titleBarOverlay: opts.kind === 'main' ? {
        color: '#0a0e1a',
        symbolColor: '#ffffff',
        height: 32,
      } : undefined,
      alwaysOnTop: opts.alwaysOnTop ?? defaults.alwaysOnTop,
      skipTaskbar: opts.skipTaskbar ?? defaults.skipTaskbar,
      resizable: opts.resizable ?? defaults.resizable,
      frame: opts.frame ?? defaults.frame,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // file:// 加载 renderer 时需要允许 cross-origin fetch 本地 backend
        webSecurity: false,
        allowRunningInsecureContent: true,
        experimentalFeatures: true,
      },
    });

    win.once('ready-to-show', () => win.show());

    win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
        void shell.openExternal(targetUrl);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });

    // 决定加载方式:detail/floating/notify/scene/dock/popover 走 hash 路由,main 走根
    const hashRoute = opts.url ? `/${opts.url}` : '';
    if (devUrl) {
      void win.loadURL(`${devUrl}#${hashRoute}`);
    } else {
      void win.loadFile(indexPath, { hash: hashRoute });
    }

    // 窗口关闭时从 pool 移除
    win.on('closed', () => {
      this.windows.delete(id);
    });

    this.windows.set(id, {
      id,
      kind: opts.kind,
      win,
      url: opts.url ?? '',
      createdAt: Date.now(),
    });

    return id;
  }

  /** 关闭窗口(从 Map 删除 + 调 win.close) */
  close(id: string): void {
    const info = this.windows.get(id);
    if (!info) return;
    this.windows.delete(id);
    if (!info.win.isDestroyed()) {
      info.win.close();
    }
  }

  /** 聚焦窗口(show + focus) */
  focus(id: string): void {
    const info = this.windows.get(id);
    if (!info || info.win.isDestroyed()) return;
    info.win.show();
    info.win.focus();
  }

  /** 调整窗口尺寸 */
  resize(id: string, w: number, h: number): void {
    const info = this.windows.get(id);
    if (!info || info.win.isDestroyed()) return;
    info.win.setSize(w, h);
  }

  /** 向所有窗口广播 IPC 事件 */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const info of this.windows.values()) {
      if (!info.win.isDestroyed()) {
        info.win.webContents.send(channel, ...args);
      }
    }
  }

  /** 列出所有窗口(精简信息,不含 win 实例) */
  list(): Array<{ id: string; kind: WindowKind; url: string; createdAt: number }> {
    return Array.from(this.windows.values()).map(({ id, kind, url, createdAt }) => ({ id, kind, url, createdAt }));
  }

  /** 取单个窗口信息 */
  get(id: string): WindowInfo | undefined {
    return this.windows.get(id);
  }

  /** 关闭所有窗口(用于 app quit 前) */
  closeAll(): void {
    for (const info of Array.from(this.windows.values())) {
      this.close(info.id);
    }
    this.windows.clear();
  }

  /** 当前窗口数量 */
  size(): number {
    return this.windows.size;
  }
}

let poolInstance: WindowPool | null = null;

/** 取单例(测试可用 resetWindowPool 重置) */
export function getWindowPool(): WindowPool {
  if (!poolInstance) {
    poolInstance = new WindowPool();
  }
  return poolInstance;
}

/** 测试辅助:重置单例 */
export function resetWindowPool(): void {
  if (poolInstance) {
    poolInstance.closeAll();
  }
  poolInstance = null;
}
