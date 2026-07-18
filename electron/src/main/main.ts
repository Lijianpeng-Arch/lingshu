/**
 * Electron Main Process — entry point
 */

// Electron must be required (CJS-style), not imported as ESM namespace.
// When vite/esbuild bundles "import * as electron from 'electron'", it
// produces `electron.app` but `electron` is undefined at runtime in CJS
// because the external 'electron' module only exposes named exports.
// Workaround: destructure immediately after require.
const electron = require('electron');
const { app, ipcMain, BrowserWindow, dialog, session, net } = electron;
import { getWindowPool, resetWindowPool } from './window-pool.js';
import { handleExportSkill } from './export-skill-handler.js';
import { selectSkillDirectory } from './select-skill-directory.js';
import { getIpcRouter } from './ipc-router.js';

const isDev = !app.isPackaged;

// On Windows headless / restricted-GPU environments the GPU process
// crashes silently, which prevents any window from showing. Disable
// hardware acceleration before app.whenReady to fall back to software
// rendering. On a normal desktop this is a no-op (Electron detects
// usable GPU and ignores the flag).
//
// Reference: https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
//            (Electron 33 still respects app.disableHardwareAcceleration)
if (process.env['LINGSHU_DISABLE_GPU'] === '1') {
  app.disableHardwareAcceleration();
}

// Also disable sandbox to avoid Windows AppContainer permission
// issues that can prevent the renderer from connecting to the GPU
// process in some sandboxes.
if (process.env['LINGSHU_DISABLE_SANDBOX'] === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

app.whenReady().then(() => {
  // Spec 1: E2E 用 VITE_LINGSHU_BACKEND_URL 重定向 renderer,但 main 进程的 IPC
  // 代理读不到 renderer 的 __BACKEND_HTTP_URL__,所以也读同一个 env 变量。
  if (process.env['VITE_LINGSHU_BACKEND_URL']) {
    process.env['LINGSHU_BACKEND_URL'] = process.env['VITE_LINGSHU_BACKEND_URL'];
  }

  // Spec 1: Electron renderer 默认 CSP 较为严格,在 file:// 加载时可能阻止
  // cross-origin fetch 到本地 backend。生产/测试场景放宽:
  //   - connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* (允许 ws + fetch)
  //   - img/style/script 同源 (Vite bundle 全部内联在 dist/renderer)
  session.defaultSession.webRequest.onHeadersReceived((details: Electron.OnHeadersReceivedListenerDetails, callback: (response: Electron.HeadersReceivedResponse) => void) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' http://127.0.0.1:* ws://127.0.0.1:*; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data:;",
        ],
      },
    });
  });

  ipcMain.handle('app:ping', () => 'pong');
  ipcMain.handle('app:version', () => app.getVersion());

  // 技能导出 — popup 系统保存对话框,把 skill 写成 .skill 文件
  ipcMain.handle('skill:export', async (_event: Electron.IpcMainInvokeEvent, skill: unknown) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    return handleExportSkill(dialog as unknown as Parameters<typeof handleExportSkill>[0], skill as Parameters<typeof handleExportSkill>[1], win);
  });

  // 本地技能安装 — popup 系统选择目录对话框,renderer 拿到路径后调后端 inspect
  ipcMain.handle('skill:select-directory', async (_event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    return selectSkillDirectory(dialog, win);
  });

  // Spec 1: renderer fetch 在 file:// 下被 Chromium 拦截,改走 IPC → net.fetch 代理。
  // 复用 backend http://127.0.0.1:<port>/<path>,由 main 进程发起请求再回传结果。
  ipcMain.handle('api:request', async (_event: Electron.IpcMainInvokeEvent, opts: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    backendUrl?: string;
  }) => {
    const base = opts.backendUrl ?? process.env['LINGSHU_BACKEND_URL'] ?? 'http://127.0.0.1:3000';
    const url = `${base}${opts.path}`;
    const init: globalThis.RequestInit = { method: opts.method };
    if (opts.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await net.fetch(url, init);
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text };
  });

  // UACS IPC router — renderer 经 preload 发 UACS envelope 给主进程, 走 IpcRouter.route
  ipcMain.handle('lingshu:invoke', async (_event: Electron.IpcMainInvokeEvent, envelopeJson: string) => {
    try {
      const envelope = JSON.parse(envelopeJson);
      const result = await getIpcRouter().route(envelope);
      return { ok: result.ok, data: result.data, error: result.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Phase A.2: WindowPool 接管所有 BrowserWindow 创建
  const pool = getWindowPool();
  pool.create({ kind: 'main' });

  // Phase A.2: 5 个 window.* IPC handler
  ipcMain.handle('window:create', (_event: Electron.IpcMainInvokeEvent, opts: Parameters<typeof pool.create>[0]) => pool.create(opts));
  ipcMain.handle('window:close', (_event: Electron.IpcMainInvokeEvent, id: string) => {
    pool.close(id);
    return { ok: true };
  });
  ipcMain.handle('window:focus', (_event: Electron.IpcMainInvokeEvent, id: string) => {
    pool.focus(id);
    return { ok: true };
  });
  ipcMain.handle('window:resize', (_event: Electron.IpcMainInvokeEvent, id: string, w: number, h: number) => {
    pool.resize(id, w, h);
    return { ok: true };
  });
  ipcMain.handle('window:list', () => pool.list());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      pool.create({ kind: 'main' });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Phase A.2: app quit 前清理 WindowPool
app.on('before-quit', () => {
  resetWindowPool();
});