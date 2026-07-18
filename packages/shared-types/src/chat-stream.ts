/**
 * @lingshu/shared-types — 聊天流式 SSE 契约
 *
 * 灵枢统一聊天通道 (POST /chat/stream) 的 SSE 事件契约。
 * 前后端唯一真相源:
 *   - 后端 backend/src/routes/chat-stream.ts 按此写出 SSE 帧
 *   - 前端 electron/src/renderer/mvp/useChat.ts 按此解析
 *
 * SSE wire 格式: 每帧 `data: <JSON>\n\n`, JSON 即下面的 ChatStreamEvent。
 * 心跳帧是 SSE 注释行 `: ping\n\n` (不含 data:), 前端直接忽略。
 *
 * 融合设计 (2026-07-18):
 *   - Phase 1 前端只消费 message_start / text_delta / message_finish / error
 *   - tool_call / usage 事件后端已发, 前端 Phase 1 收到即忽略, v0.2 点亮渲染
 *   - 加新事件类型时只在此文件加一个 variant, 前后端自动对齐
 */

/** 4 个统一 provider 命名 (与 backend models/registry ModelProvider 一致) */
export type ChatStreamProvider = 'deepseek' | 'openai' | 'anthropic' | 'ollama';

/** 工具调用事件 (v0.2 渲染; Phase 1 前端忽略). 后端 envelopes/tool-call ToolCallEvent 的透传体. */
export interface ChatStreamToolCall {
  type: string;
  toolCallId: string;
  [key: string]: unknown;
}

/**
 * 统一聊天 SSE 事件联合类型。
 *
 * 一次正常对话的事件序列:
 *   message_start → text_delta* → (usage?) → message_finish
 * 出错时:
 *   message_start → error
 */
export type ChatStreamEvent =
  /** 流开始, 携带 messageId + 选中的 provider */
  | { type: 'message_start'; messageId: string; model: ChatStreamProvider; timestamp: number }
  /** token-by-token 文本增量 (前端追加渲染) */
  | { type: 'text_delta'; messageId: string; delta: string }
  /** 工具调用事件透传 (Phase 1 忽略, v0.2 渲染) */
  | { type: 'tool_call'; messageId: string; event: ChatStreamToolCall }
  /** awareness 快照透传 (Phase 1 忽略) */
  | { type: 'awareness'; messageId: string; envelope: unknown }
  /** token 用量 (仅出现在 message_finish 之前; Phase 1 忽略, v0.2 显示费用条) */
  | {
      type: 'usage';
      messageId: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      provider: ChatStreamProvider;
      model: string;
    }
  /** 流正常结束 */
  | { type: 'message_finish'; messageId: string; finishReason: string | null; timestamp: number }
  /** 流出错结束 (友好文案在 message; recoverable=false 表示要用户去改设置, 如密钥无效) */
  | { type: 'error'; messageId: string; code: string; message: string; recoverable: boolean };

/** POST /chat/stream 请求体 (与 backend ChatStreamBodySchema 对齐) */
export interface ChatStreamRequest {
  message: string;
  model?: ChatStreamProvider;
  conversationId?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}
