/**
 * IpcRouter — UACS envelope 路由 (Phase W1.2)
 *
 * 后端发 envelope 到 renderer → renderer apiRequest IPC 调到主进程 → 主进程 IpcRouter.route(env)
 * → 调 WindowPool → 回 envelope (window.id 等)
 *
 * 设计原则:
 * - 单例 getIpcRouter (跟 Pool 一致)
 * - 路由表: envelope.type → handler
 * - handler 返回 { ok, data?, error? } 由 caller 决定如何 emit 回 envelope
 * - 暂不实装 window.message (留给前端 renderer-renderer 直连)
 */

import { getWindowPool } from './window-pool.js';

export type UACSEnvelopeLite = {
  id: string;
  type: string;
  sender: string;
  recipient: string;
  timestamp: number;
  correlationId: string | null;
  traceMeta: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

export interface RouteResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class IpcRouter {
  private routes = new Map<string, (env: UACSEnvelopeLite) => Promise<RouteResult>>();

  constructor() {
    this.register('window.create', this.handleWindowCreate.bind(this));
    this.register('window.close', this.handleWindowClose.bind(this));
    this.register('window.focus', this.handleWindowFocus.bind(this));
    this.register('window.resize', this.handleWindowResize.bind(this));
    this.register('capability.invoke', this.handleCapabilityInvoke.bind(this));
  }

  private register(type: string, handler: (env: UACSEnvelopeLite) => Promise<RouteResult>) {
    this.routes.set(type, handler);
  }

  async route(envelope: UACSEnvelopeLite): Promise<RouteResult> {
    const handler = this.routes.get(envelope.type);
    if (!handler) {
      return { ok: false, error: `router: ${envelope.type} not implemented` };
    }
    try {
      return await handler(envelope);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleWindowCreate(env: UACSEnvelopeLite): Promise<RouteResult> {
    const p = env.payload as { kind: string; w?: number; h?: number; url?: string; title?: string } | undefined;
    if (!p?.kind) return { ok: false, error: 'window.create missing payload.kind' };
    const validKinds = ['main', 'floating', 'detail', 'notify'] as const;
    if (!validKinds.includes(p.kind as typeof validKinds[number])) {
      return { ok: false, error: `window.create invalid kind: ${p.kind}` };
    }
    const id = getWindowPool().create({
      kind: p.kind as typeof validKinds[number],
      width: p.w,
      height: p.h,
      url: p.url,
      title: p.title,
    });
    return { ok: true, data: { id } };
  }

  private async handleWindowClose(env: UACSEnvelopeLite): Promise<RouteResult> {
    const p = env.payload as { id?: string } | undefined;
    if (!p?.id) return { ok: false, error: 'window.close missing payload.id' };
    getWindowPool().close(p.id);
    return { ok: true };
  }

  private async handleWindowFocus(env: UACSEnvelopeLite): Promise<RouteResult> {
    const p = env.payload as { id?: string } | undefined;
    if (!p?.id) return { ok: false, error: 'window.focus missing payload.id' };
    getWindowPool().focus(p.id);
    return { ok: true, data: { id: p.id } };
  }

  private async handleWindowResize(env: UACSEnvelopeLite): Promise<RouteResult> {
    const p = env.payload as { id?: string; w?: number; h?: number } | undefined;
    if (!p?.id || !p.w || !p.h) return { ok: false, error: 'window.resize missing payload' };
    getWindowPool().resize(p.id, p.w, p.h);
    return { ok: true, data: { id: p.id, w: p.w, h: p.h } };
  }

  private async handleCapabilityInvoke(env: UACSEnvelopeLite): Promise<RouteResult> {
    const p = env.payload as { capability?: string; args?: Record<string, unknown> } | undefined;
    if (!p?.capability) return { ok: false, error: 'capability.invoke missing payload.capability' };
    return { ok: false, error: `unknown capability: ${p.capability}` };
  }
}

let routerInstance: IpcRouter | null = null;

export function getIpcRouter(): IpcRouter {
  if (!routerInstance) routerInstance = new IpcRouter();
  return routerInstance;
}

export function resetIpcRouter(): void {
  routerInstance = null;
}
