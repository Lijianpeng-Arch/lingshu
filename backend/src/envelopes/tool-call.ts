/**
 * Tool Call Envelope Events (V6 ACUI 协议扩展)
 *
 * 3 个新事件类型,给前端 AgentActivityCards 用。借鉴 Vercel AI SDK
 * tool-call streaming 语义, 把它封装成我们自己的 envelope,
 * 通过 awareness 通道广播 (复用现有 ws 通道,不破坏原协议)。
 *
 * 设计原则:
 *   - 完全 in-memory, 不走 DB, 不走 SQLite
 *   - 工具调用的全套 3 事件: start → args_delta → result
 *   - 不依赖外部 transport (HTTP / WS), 只通过 awareness 通道
 *   - 测试容易: 只需要 mock awarenessHandlers
 *   - 跨聊天路由: 每个事件带 conversationId, 订阅者可按会话过滤
 *     避免把 A 会话的工具卡片错投到 B 会话
 */

// ── Tool Call Start ────────────────────────────────────────────────
// 工具即将被调用。给前端 AgentActivityCards 新建一个 card 的时机。
export interface ToolCallStartEvent {
  type: 'tool_call_start';
  /** 工具调用唯一 ID (整个 start/args/result 链路共享) */
  toolCallId: string;
  /** 触发本次工具的会话 ID (SSE 订阅者按它路由, 避免跨聊天串扰) */
  conversationId?: string;
  /** 工具内部名 (e.g. 'read_file') */
  name: string;
  /** 工具中文展示名 (e.g. '读取文件') — ToolDefinition.displayName */
  displayName: string;
  /** 工具中文描述 (e.g. '读取指定路径的文件内容') */
  displayDescription: string;
  /** 工具参数 (JSON 对象) — start 时一次性全量给前端 */
  args: Record<string, unknown>;
  /** 工具风险等级 (low/medium/high) — 决定要不要权限弹窗 */
  risk?: 'low' | 'medium' | 'high';
  /** 触发时间戳 (ms) */
  timestamp: number;
}

// ── Tool Call Args Delta ───────────────────────────────────────────
// 工具参数 streaming delta (LLM 流式工具调用时用)。
// V6 前端卡可能拼接 args 让用户看到"正在构建参数"。
export interface ToolCallArgsDeltaEvent {
  type: 'tool_call_args_delta';
  toolCallId: string;
  /** 触发本次工具的会话 ID */
  conversationId?: string;
  /** JSON string 的 delta 片段 */
  argsDelta: string;
}

// ── Tool Call Result ───────────────────────────────────────────────
// 工具调用结束 (成功 / 失败) — 给前端 AgentActivityCards 改状态。
export interface ToolCallResultEvent {
  type: 'tool_call_result';
  toolCallId: string;
  /** 触发本次工具的会话 ID */
  conversationId?: string;
  /** 工具结果 (任意 JSON, 由 tool 自己决定 shape) */
  result: unknown;
  /** 耗时 (ms) */
  durationMs: number;
  /** 状态: success / error */
  status: 'success' | 'error';
  /** 失败时的错误消息(中文友好版) */
  errorMessage?: string;
}

// ── Union ─────────────────────────────────────────────────────────
export type ToolCallEvent =
  | ToolCallStartEvent
  | ToolCallArgsDeltaEvent
  | ToolCallResultEvent;

// ── Awareness Subscribers (V6 专用) ───────────────────────────────
// 借鉴 Hermes / OpenCode 的 hook pattern:
//   - 多个订阅者并存
//   - 通过 setter 注册,setter clear 来关闭订阅
//   - 测试时 push handler, 跑完 unsub,
//   - 生产环境 SSE/ws bridge 内部注册
type AwarenessHandler = (event: ToolCallEvent) => void;

const awarenessHandlers: AwarenessHandler[] = [];

/** 注册 tool_call awareness 事件订阅者。返回 unsubscriber。 */
export function subscribeToolCallEvents(handler: AwarenessHandler): () => void {
  awarenessHandlers.push(handler);
  return () => {
    const idx = awarenessHandlers.indexOf(handler);
    if (idx >= 0) awarenessHandlers.splice(idx, 1);
  };
}

/** 给所有订阅者广播一个 tool_call event。 */
export function emitToolCall(event: ToolCallEvent): void {
  for (const h of awarenessHandlers) {
    try {
      h(event);
    } catch (err) {
      console.error('[envelopes/tool-call] handler threw:', err);
    }
  }
}

/** 测试专用:清空所有订阅者。 */
export function _clearToolCallHandlersForTest(): void {
  awarenessHandlers.length = 0;
}

/** 测试专用:当前订阅者数。 */
export function _toolCallHandlerCountForTest(): number {
  return awarenessHandlers.length;
}
