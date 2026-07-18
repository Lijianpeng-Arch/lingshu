/**
 * UACS Dispatcher — routes envelopes to registered handlers
 *
 * Phase 1: pure TS, in-memory handler map
 * Phase C.4: real capability.invoke / capability.result handlers with inflight promise map
 */

import { randomUUID } from 'node:crypto';
import type { UACSEnvelope, UACSEnvelopeType, CapabilityInvokePayload, CapabilityResultPayload } from './envelope.js';
import { registerAwarenessHandlers } from '../agent/awareness.js';
import { registerWindowHandlers, type WindowHandlerDeps } from './window-handler.js';

export type UACSHandler = (envelope: UACSEnvelope) => Promise<void> | void;

export interface Dispatcher {
  register(type: UACSEnvelopeType, handler: UACSHandler): void;
  registerWildcard(handler: UACSHandler): void;
  unregister(type: UACSEnvelopeType): void;
  dispatch(envelope: UACSEnvelope): Promise<void>;
}

function notImplemented(type: UACSEnvelopeType): UACSHandler {
  return () => {
    throw new Error(`NotImplemented: ${type} will be implemented in a later phase`);
  };
}

export interface DispatcherDeps {
  /**
   * Optional agent-layer deps. When provided, the dispatcher wires awareness
   * handlers from `backend/src/agent/awareness.ts` so renderer-originated
   * `awareness.snapshot` / `awareness.update` envelopes have real handlers
   * instead of the Phase A.1 stubs.
   */
  agent?: {
    mainLoop: import('../agent/main-loop.js').MainLoop;
  };
  /**
   * Phase W4 — optional window handler deps. When provided, dispatcher
   * registers 6 window.* handlers + capability.invoke v2 forwarder.
   */
  window?: WindowHandlerDeps;
}

// ── Phase C.4 — capability.invoke / capability.result inflight store ──────────
// Backend 不能 require electron,所以 capability 的实际执行在主进程 (BrowserPool/MediaPool/MapProvider)。
// 后端做的是:
//   1. emitCapabilityInvoke: 生成 invokeId,emit capability.invoke envelope 给 renderer
//      (renderer 端在 Phase C.5 收口时通过 api:request IPC 调主进程)
//   2. capability.result handler: 接收 renderer 回传的结果,resolve 对应 invokeId 的 promise
//
// chat-handler 通过 awaitCapabilityResult(invokeId) 等待结果。
const CAPABILITY_TIMEOUT_MS = 60_000;

interface InflightCapability {
  capability: string;
  args: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const inflightCapabilities = new Map<string, InflightCapability>();

/**
 * Public: emit a capability.invoke envelope and return the invokeId.
 * chat-handler 调用此函数发 capability.invoke,然后 awaitCapabilityResult(invokeId) 等结果。
 *
 * 设计: invokeId 通过 envelope.correlationId 通道传递 (renderer 回传 capability.result 时
 * 把 invokeId 放进 correlationId)。这样不依赖 TraceMetaSchema 改动。
 */
export interface EmitCapabilityInvokeOptions {
  capability: CapabilityInvokePayload['capability'];
  args: Record<string, unknown>;
  /** 来源 envelope (用于 envelope id/traceMeta) */
  source: UACSEnvelope;
  /** emit 通道 — 通常是 ChatHandlerDeps.emit */
  emit: (env: UACSEnvelope) => void;
  /** 可选超时, 默认 60s */
  timeoutMs?: number;
}

export function emitCapabilityInvoke(opts: EmitCapabilityInvokeOptions): string {
  const invokeId = `cap-${randomUUID()}`;
  const timeoutMs = opts.timeoutMs ?? CAPABILITY_TIMEOUT_MS;
  // 预占 slot, 这样 chat-handler 立刻 await 也能找到
  inflightCapabilities.set(invokeId, {
    capability: opts.capability,
    args: opts.args,
    resolve: () => {},
    reject: () => {},
    timer: setTimeout(() => {}, timeoutMs), // placeholder, 立刻被 awaitCapabilityResult replace
  });

  // emit 给 renderer
  const env: UACSEnvelope = {
    ...opts.source,
    id: `env-${randomUUID()}`,
    type: 'capability.invoke',
    sender: 'backend',
    recipient: 'electron',
    timestamp: Date.now(),
    correlationId: invokeId,
    traceMeta: opts.source.traceMeta ?? {},
    payload: {
      capability: opts.capability,
      args: opts.args,
    },
  };
  opts.emit(env);
  return invokeId;
}

/**
 * Public: 等待 capability.invoke 的结果。
 * chat-handler 调用此函数阻塞,直到 renderer 通过 capability.result envelope 回传结果。
 *
 * 必须在 emitCapabilityInvoke 之后调用,且使用相同的 invokeId。
 */
export function awaitCapabilityResult(
  invokeId: string,
  timeoutMs: number = CAPABILITY_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const existing = inflightCapabilities.get(invokeId);
    if (!existing) {
      reject(new Error(`capability ${invokeId} not found (slot missing — was emitCapabilityInvoke called?)`));
      return;
    }
    clearTimeout(existing.timer);
    existing.resolve = resolve;
    existing.reject = reject;
    const timer = setTimeout(() => {
      if (inflightCapabilities.has(invokeId)) {
        inflightCapabilities.delete(invokeId);
        reject(new Error(`capability ${invokeId} timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    existing.timer = timer;
  });
}

/**
 * 内部: 处理 capability.result envelope 时调用。resolve/reject 对应 invokeId 的 promise。
 */
function resolveCapabilityResult(invokeId: string, payload: CapabilityResultPayload): boolean {
  const inflight = inflightCapabilities.get(invokeId);
  if (!inflight) return false;
  inflightCapabilities.delete(invokeId);
  clearTimeout(inflight.timer);
  if (payload.success) {
    inflight.resolve(payload.result);
  } else {
    inflight.reject(new Error(payload.error ?? 'capability failed'));
  }
  return true;
}

/**
 * Test-only: 清空 inflight map 并清理所有 timer。在测试间清理防止泄漏。
 */
export function _clearInflightCapabilitiesForTest(): void {
  for (const [, inflight] of inflightCapabilities) {
    clearTimeout(inflight.timer);
  }
  inflightCapabilities.clear();
}

export function createDispatcher(deps: DispatcherDeps = {}): Dispatcher {
  const handlers = new Map<UACSEnvelopeType, UACSHandler>();
  const wildcards: UACSHandler[] = [];

  // Phase A.1 — stub handlers for awareness.* (window.* / capability.* 在 window-handler 注册)
  const stubs: UACSEnvelopeType[] = [
    'awareness.update',
    'awareness.snapshot',
  ];
  for (const t of stubs) handlers.set(t, notImplemented(t));

  // Phase W4 — window.* / capability.invoke v2 由 window-handler.registerWindowHandlers 提供。
  // 此处不预设这些 handler 的 stub,让 window-handler 显式注册 (避免双重 handler)。

  // Phase C.4 — real capability.result handler
  // 接收 renderer 回传的结果, resolve 对应 invokeId 的 promise
  // invokeId 通过 envelope.correlationId 传递 (emitCapabilityInvoke 把 invokeId 放 correlationId)
  handlers.set('capability.result', (env: UACSEnvelope) => {
    if (env.type !== 'capability.result') return;
    const payload = env.payload;
    if (!payload) {
      console.warn('[dispatcher] capability.result missing payload');
      return;
    }
    const invokeId = env.correlationId;
    if (!invokeId) {
      console.warn('[dispatcher] capability.result missing invokeId (correlationId is null)');
      return;
    }
    const resolved = resolveCapabilityResult(invokeId, payload);
    if (!resolved) {
      console.warn(`[dispatcher] capability.result: no inflight for ${invokeId} (timeout or unknown)`);
    }
  });

  // Phase B.1 — replace awareness.* stubs with real handlers from the agent
  // layer when a MainLoop has been wired in. Without this, server-side
  // dispatchers created with createDispatcher() keep the stubs so the
  // existing test surface is unaffected.
  if (deps.agent?.mainLoop) {
    registerAwarenessHandlers(
      { mainLoop: deps.agent.mainLoop },
      (type, handler) => { handlers.set(type, handler as UACSHandler); },
    );
  }

  // Phase W4 — wire window.* handlers + capability.invoke v2 forwarder when
  // window deps are provided.
  if (deps.window) {
    registerWindowHandlers(deps.window, (type, handler) => { handlers.set(type, handler as UACSHandler); });
  }

  return {
    register(type, handler) { handlers.set(type, handler); },
    registerWildcard(handler) { wildcards.push(handler); },
    unregister(type) {
      // Preserve stub for Phase A.1 types so dispatch never silently drops them
      if ((stubs as readonly string[]).includes(type)) {
        handlers.set(type, notImplemented(type));
      } else {
        handlers.delete(type);
      }
    },
    async dispatch(envelope) {
      const handler = handlers.get(envelope.type);
      const allHandlers = handler ? [handler, ...wildcards] : wildcards;
      if (allHandlers.length === 0) {
        throw new Error(`No handler registered for envelope type "${envelope.type}"`);
      }
      if (handler) {
        try {
          await handler(envelope);
        } catch (err) {
          console.error(`[uacs] handler error for ${envelope.type}:`, err);
        }
      }
      await Promise.all(
        wildcards
          .filter((w) => w !== handler)
          .map((w) => Promise.resolve(w(envelope)).catch((err) => {
            console.error(`[uacs] wildcard error for ${envelope.type}:`, err);
          }))
      );
    },
  };
}