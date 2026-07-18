/**
 * Phase W4 — Window Handlers
 *
 * 6 个 UACS handler (window.create/close/focus/resize/message/preset) +
 * capability.invoke v2 转发。
 *
 * 依赖:
 * - emit:        把新的 envelope 推回 UACS bus
 * - ipcSend:     调主进程 IPC (e.g. apiRequest)
 * - askUser:     UI 询问 (allow/deny)
 *
 * close main-kind 走 gate.evaluateWindowOp,默认 deny。
 * capability.invoke 走白名单 + v2 fields (timeoutMs/priority/fallback/preload)。
 */

import { randomUUID } from 'node:crypto';
import type {
  UACSEnvelope,
  WindowCreatePayload,
  WindowClosePayload,
  WindowFocusPayload,
  WindowResizePayload,
  WindowMessagePayload,
  WindowPresetPayload,
  CapabilityInvokePayload,
  WindowPreset,
} from './envelope.js';
import { getPreset } from './window-presets.js';
import {
  evaluateWindowOp,
  DENY_CLOSE_MAIN_REASON,
  WINDOW_ALLOW_TTL_MS,
} from '../permission/gate.js';

export interface WindowHandlerDeps {
  /** 推回 envelope 到 UACS bus */
  emit: (env: UACSEnvelope) => void;
  /** 转发到主进程 IPC。返回主进程给的 RouteResult 或 raw payload */
  ipcSend: (channel: string, payload: unknown) => Promise<unknown>;
  /** UI 询问。返回用户选择 */
  askUser: (q: { title: string; body: string }) => Promise<'allow' | 'deny'>;
}

type RegisterFn = (type: UACSEnvelope['type'], handler: (env: UACSEnvelope) => Promise<void> | void) => void;

/** Window IPC channel — 主进程 IpcRouter.register('window.*') 用的 channel */
const IPC_WINDOW_CHANNEL = 'window.dispatch';
/** Capability IPC channel */
const IPC_CAPABILITY_CHANNEL = 'capability.dispatch';

/** close main-kind 的 id 约定: 主驾驶舱 id 通常是 'main-1' */
const MAIN_WINDOW_ID_PREFIX = 'main-';

/** allow 缓存: opKind:target → timestamp */
const allowedCache = new Map<string, number>();

/** 测试用: 清空缓存 */
export function _clearWindowAllowCacheForTest(): void {
  allowedCache.clear();
}

function cacheKey(op: string, target: string): string {
  return `${op}:${target}`;
}

function isAllowedCached(op: string, target: string): boolean {
  const key = cacheKey(op, target);
  const ts = allowedCache.get(key);
  if (!ts) return false;
  if (Date.now() - ts > WINDOW_ALLOW_TTL_MS) {
    allowedCache.delete(key);
    return false;
  }
  return true;
}

function markAllowed(op: string, target: string): void {
  allowedCache.set(cacheKey(op, target), Date.now());
}

/** Emit error envelope (capability.result / error type) */
function emitError(d: WindowHandlerDeps, source: UACSEnvelope, code: string, message: string, recoverable = false): void {
  d.emit({
    ...source,
    id: `env-${randomUUID()}`,
    type: 'error',
    sender: 'backend',
    recipient: 'electron',
    timestamp: Date.now(),
    correlationId: source.correlationId,
    traceMeta: source.traceMeta ?? {},
    payload: { code, message, recoverable, details: {} },
  });
}

/** Emit capability.result (for capability.invoke v2) */
function emitCapabilityResult(
  d: WindowHandlerDeps,
  source: UACSEnvelope,
  payload: { capability: string; success: boolean; result?: unknown; error?: string },
): void {
  d.emit({
    ...source,
    id: `env-${randomUUID()}`,
    type: 'capability.result',
    sender: 'backend',
    recipient: 'electron',
    timestamp: Date.now(),
    correlationId: source.correlationId,
    traceMeta: source.traceMeta ?? {},
    payload,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6 个 window.* handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleWindowCreate(d: WindowHandlerDeps, env: UACSEnvelope): Promise<void> {
  if (env.type !== 'window.create') return;
  const payload = env.payload as WindowCreatePayload | undefined;
  if (!payload?.kind) {
    emitError(d, env, 'window.create.missing_kind', 'window.create missing payload.kind');
    return;
  }

  // gate 校验
  const decision = evaluateWindowOp('create', {
    kind: payload.kind,
    bypassConfirm: payload.requireConfirm === false,
  });

  if (decision === 'deny') {
    emitError(d, env, 'window.create.denied', 'window.create denied by gate');
    return;
  }

  if (decision === 'ask' && !isAllowedCached('create', payload.kind)) {
    const userChoice = await d.askUser({
      title: '打开新窗口',
      body: `确定要打开 ${payload.kind} 类型的窗口吗?`,
    });
    if (userChoice === 'deny') {
      emitError(d, env, 'window.create.denied_by_user', '用户拒绝了窗口创建');
      return;
    }
    markAllowed('create', payload.kind);
  }

  // 转发 IPC
  try {
    const result = await d.ipcSend(IPC_WINDOW_CHANNEL, { type: 'window.create', payload });
    // emit 一个 capability.result-like ack (用 envelope payload 字段)
    d.emit({
      ...env,
      id: `env-${randomUUID()}`,
      type: 'window.message',
      sender: 'backend',
      recipient: 'electron',
      timestamp: Date.now(),
      correlationId: env.correlationId,
      traceMeta: env.traceMeta ?? {},
      payload: {
        from: 'window-pool',
        to: payload.kind,
        message: { kind: 'created', result },
      },
    });
  } catch (err) {
    emitError(d, env, 'window.create.ipc_error', err instanceof Error ? err.message : String(err));
  }
}

async function handleWindowClose(d: WindowHandlerDeps, env: UACSEnvelope): Promise<void> {
  if (env.type !== 'window.close') return;
  const payload = env.payload as WindowClosePayload | undefined;
  if (!payload?.id) {
    emitError(d, env, 'window.close.missing_id', 'window.close missing payload.id');
    return;
  }

  // gate 校验 — close main-kind 硬 deny
  const kindHint: 'main' | 'floating' | 'detail' | 'notify' | undefined =
    payload.id.startsWith(MAIN_WINDOW_ID_PREFIX) ? 'main' : undefined;

  const decision = evaluateWindowOp('close', { id: payload.id, kind: kindHint });

  if (decision === 'deny') {
    emitError(d, env, 'window.close.denied_main', DENY_CLOSE_MAIN_REASON);
    return;
  }

  if (decision === 'ask' && !isAllowedCached('close', payload.id)) {
    const userChoice = await d.askUser({
      title: '关闭窗口',
      body: `确定要关闭窗口 ${payload.id} 吗?`,
    });
    if (userChoice === 'deny') {
      emitError(d, env, 'window.close.denied_by_user', '用户拒绝关闭窗口');
      return;
    }
    markAllowed('close', payload.id);
  }

  try {
    await d.ipcSend(IPC_WINDOW_CHANNEL, { type: 'window.close', payload });
  } catch (err) {
    emitError(d, env, 'window.close.ipc_error', err instanceof Error ? err.message : String(err));
  }
}

async function handleWindowFocus(d: WindowHandlerDeps, env: UACSEnvelope): Promise<void> {
  if (env.type !== 'window.focus') return;
  const payload = env.payload as WindowFocusPayload | undefined;
  if (!payload?.id) {
    emitError(d, env, 'window.focus.missing_id', 'window.focus missing payload.id');
    return;
  }
  try {
    await d.ipcSend(IPC_WINDOW_CHANNEL, { type: 'window.focus', payload });
  } catch (err) {
    emitError(d, env, 'window.focus.ipc_error', err instanceof Error ? err.message : String(err));
  }
}

async function handleWindowResize(d: WindowHandlerDeps, env: UACSEnvelope): Promise<void> {
  if (env.type !== 'window.resize') return;
  const payload = env.payload as WindowResizePayload | undefined;
  if (!payload?.id || !payload.w || !payload.h) {
    emitError(d, env, 'window.resize.missing_fields', 'window.resize missing payload.id/w/h');
    return;
  }
  try {
    await d.ipcSend(IPC_WINDOW_CHANNEL, { type: 'window.resize', payload });
  } catch (err) {
    emitError(d, env, 'window.resize.ipc_error', err instanceof Error ? err.message : String(err));
  }
}

async function handleWindowMessage(d: WindowHandlerDeps, env: UACSEnvelope): Promise<void> {
  if (env.type !== 'window.message') return;
  const payload = env.payload as WindowMessagePayload | undefined;
  if (!payload?.from || !payload?.to) {
    emitError(d, env, 'window.message.missing_fields', 'window.message missing from/to');
    return;
  }
  // window.message 不需要问 (纯本地)
  try {
    await d.ipcSend(IPC_WINDOW_CHANNEL, { type: 'window.message', payload });
  } catch (err) {
    emitError(d, env, 'window.message.ipc_error', err instanceof Error ? err.message : String(err));
  }
}

async function handleWindowPreset(d: WindowHandlerDeps, env: UACSEnvelope): Promise<void> {
  if (env.type !== 'window.preset') return;
  const payload = env.payload as WindowPresetPayload | undefined;
  if (!payload?.preset) {
    emitError(d, env, 'window.preset.missing_preset', 'window.preset missing payload.preset');
    return;
  }

  // preset 默认 ask
  const decision = evaluateWindowOp('preset', { preset: payload.preset });
  if (decision === 'ask' && !isAllowedCached('preset', payload.preset)) {
    const userChoice = await d.askUser({
      title: '切换窗口布局',
      body: `确定要切换到 ${payload.preset} 预设布局吗?`,
    });
    if (userChoice === 'deny') {
      emitError(d, env, 'window.preset.denied_by_user', '用户拒绝切换布局');
      return;
    }
    markAllowed('preset', payload.preset);
  }

  // 按 preset 创建一组窗口
  const layout = getPreset(payload.preset as WindowPreset);
  for (const w of layout.windows) {
    const createPayload: WindowCreatePayload = {
      kind: w.kind,
      url: w.type,
      w: w.bounds?.width,
      h: w.bounds?.height,
      title: w.type,
      requireConfirm: false, // preset 用户已确认
    };
    d.emit({
      ...env,
      id: `env-${randomUUID()}`,
      type: 'window.create',
      sender: 'backend',
      recipient: 'electron',
      timestamp: Date.now(),
      correlationId: env.correlationId,
      traceMeta: env.traceMeta ?? {},
      payload: createPayload,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// capability.invoke v2 转发 (whitelist + v2 fields)
// ─────────────────────────────────────────────────────────────────────────────

/** capability 白名单 — 跟 CapabilityInvokePayloadSchema 一致 */
const CAPABILITY_WHITELIST = new Set(['browser', 'map', 'media', 'skill']);

export async function handleCapabilityInvokeV2(d: WindowHandlerDeps, env: UACSEnvelope): Promise<void> {
  if (env.type !== 'capability.invoke') return;
  const payload = env.payload as CapabilityInvokePayload | undefined;
  if (!payload?.capability) {
    emitError(d, env, 'capability.invoke.missing_capability', 'capability.invoke missing payload.capability');
    return;
  }
  if (!CAPABILITY_WHITELIST.has(payload.capability)) {
    emitError(d, env, 'capability.invoke.not_whitelisted', `capability "${payload.capability}" not in whitelist`);
    return;
  }

  // v2 fields: timeoutMs/priority/fallback/preload (全部可选)
  try {
    const result = await d.ipcSend(IPC_CAPABILITY_CHANNEL, payload);
    emitCapabilityResult(d, env, {
      capability: payload.capability,
      success: true,
      result,
    });
  } catch (err) {
    // 尝试 fallback capability (如果 v2 指定了)
    if (payload.fallback && CAPABILITY_WHITELIST.has(payload.fallback)) {
      try {
        const fallbackResult = await d.ipcSend(IPC_CAPABILITY_CHANNEL, {
          ...payload,
          capability: payload.fallback,
        });
        emitCapabilityResult(d, env, {
          capability: payload.fallback,
          success: true,
          result: fallbackResult,
        });
        return;
      } catch {
        // fall through to error
      }
    }
    emitCapabilityResult(d, env, {
      capability: payload.capability,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 注册入口
// ─────────────────────────────────────────────────────────────────────────────

export function registerWindowHandlers(d: WindowHandlerDeps, reg: RegisterFn): void {
  reg('window.create', (env) => handleWindowCreate(d, env));
  reg('window.close', (env) => handleWindowClose(d, env));
  reg('window.focus', (env) => handleWindowFocus(d, env));
  reg('window.resize', (env) => handleWindowResize(d, env));
  reg('window.message', (env) => handleWindowMessage(d, env));
  reg('window.preset', (env) => handleWindowPreset(d, env));
  reg('capability.invoke', (env) => handleCapabilityInvokeV2(d, env));
}