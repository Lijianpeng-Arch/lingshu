/**
 * Chat Stream SSE Route — 灵枢统一聊天通道
 *
 * POST /chat/stream
 *   body: { message: string, model?: ModelProvider, conversationId?: string }
 *   returns: text/event-stream
 *     - message_start     → 流开始, 含 messageId
 *     - text_delta        → token-by-token 文本片段
 *     - tool_call         → 转发的 ToolCallEvent (from envelopes/tool-call)
 *     - awareness         → awareness.update / snapshot 透传
 *     - message_finish    → 流结束, 包含 finishReason
 *     - error             → 错误, 流结束
 *   心跳:  ": ping\n\n" 每 15s
 *   鉴权: Authorization: Bearer <token>  (无 token 也允许, 跟 WS /api/health 一致 — V6 单机本地)
 *
 * 设计原则:
 *   - 不破坏现有 ws /chat 主通道 (chat-handler 仍然走 ws)
 *   - 复用 models/registry.streamChat 走 4 个 provider
 *   - 订阅 tools/envelopes/tool-call 把它转成 SSE event
 *   - 复用 main-loop 的 awareness 通道,把 awareness.update envelope 透传
 *   - AbortController: client close → abort LLM stream
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  streamChat,
  listAvailableProviders,
  type ModelProvider,
} from '../models/registry.js';
import {
  subscribeToolCallEvents,
  type ToolCallEvent,
} from '../envelopes/tool-call.js';
import { newId } from '../util/id.js';
import { sessionRegistry } from '../session/registry.js';
import type { MainLoop } from '../agent/main-loop.js';
import type { ChatMessage } from '../providers/types.js';
import type { ToolRegistry, ToolDefinition } from '../tools/registry.js';
import { createToolRegistry } from '../tools/registry.js';
import { BUILTIN_TOOLS } from '../tools/builtin.js';
import { emitToolCall, type ToolCallResultEvent, type ToolCallStartEvent } from '../envelopes/tool-call.js';

// ── Request schema ─────────────────────────────────────────────
const ChatStreamBodySchema = z.object({
  message: z.string().min(1).max(100_000),
  model: z
    .enum(['deepseek', 'openai', 'anthropic', 'ollama'])
    .optional(),
  conversationId: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(32_000).optional(),
});
type ChatStreamBody = z.infer<typeof ChatStreamBodySchema>;

// ── SSE wire format ────────────────────────────────────────────
type SseEvent =
  | { type: 'message_start'; messageId: string; model: ModelProvider; timestamp: number }
  | { type: 'text_delta'; messageId: string; delta: string }
  | { type: 'tool_call'; messageId: string; event: ToolCallEvent }
  | { type: 'awareness'; messageId: string; envelope: unknown }
  | {
      type: 'usage';
      messageId: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      provider: ModelProvider;
      model: string;
    }
  | { type: 'message_finish'; messageId: string; finishReason: string | null; timestamp: number }
  | { type: 'error'; messageId: string; code: string; message: string; recoverable: boolean };

function sseEncode(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// 心跳: SSE 注释行
function ssePing(): string {
  return `: ping\n\n`;
}

// ── 心跳 / timeout 常量 ─────────────────────────────────────────
const HEARTBEAT_MS = 15_000;
const STREAM_TIMEOUT_MS = 600_000; // 10 分钟, 跟 chat-handler watchdog 默认值一致

// ── Route factory ──────────────────────────────────────────────
export interface ChatStreamRouteDeps {
  /** MainLoop — 用于拉 awareness snapshot 推到前端 */
  mainLoop?: MainLoop;
  /** 默认 model (无 body.model 时用) */
  defaultProvider?: ModelProvider;
  /** Tool registry used by the real LLM tool loop. */
  toolRegistry?: ToolRegistry;
  /** Optional session repo — when provided, every chat round is persisted. */
  sessionRepo?: import('../db/session-repo.js').SessionRepo;
}

export function createChatStreamRoute(deps: ChatStreamRouteDeps = {}) {
  const defaultProvider: ModelProvider =
    deps.defaultProvider ??
    (listAvailableProviders().includes('deepseek') ? 'deepseek' : 'ollama');
  const toolRegistry = deps.toolRegistry ?? (() => {
    const registry = createToolRegistry();
    registry.registerMany(BUILTIN_TOOLS);
    return registry;
  })();
  const MAX_TOOL_TURNS = 8;

  return async function chatStreamHandler(
    req: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply,
  ): Promise<void> {
    // ── 1. parse body ─────────────────────────────────────────
    const parsed = ChatStreamBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      reply.send({ ok: false, error: parsed.error.message });
      return;
    }
    const body: ChatStreamBody = parsed.data;
    const provider = body.model ?? defaultProvider;
    const messageId = newId('msg');

    // ── 2. SSE headers ───────────────────────────────────────
    // raw socket hijack: 用 reply.hijack() 拿到原生 res, 自己写 SSE 帧。
    void reply.code(200);
    void reply.header('Content-Type', 'text/event-stream; charset=utf-8');
    void reply.header('Cache-Control', 'no-cache, no-transform');
    void reply.header('Connection', 'keep-alive');
    void reply.header('X-Accel-Buffering', 'no');
    void reply.send(); // 显式 begin response — fastify 才能切到 raw

    const raw = reply.raw;
    // 让 Node 知道这是一个 streaming response
    if ('flushHeaders' in raw && typeof raw.flushHeaders === 'function') {
      try {
        (raw as { flushHeaders: () => void }).flushHeaders();
      } catch {
        // ignore — some sandbox envs (test) 不支持
      }
    }

    const write = (data: string): void => {
      if (closed) return;
      // 检查 raw 是否真的不可写 (测试环境的 mock 可能 writable undefined)
      try {
        if (raw.writableEnded === true || raw.destroyed === true) {
          closed = true;
          return;
        }
      } catch {
        // raw 上无该属性 (mock 情况) — 假定可写
      }
      try {
        raw.write(data);
      } catch {
        // client closed: 吞掉, 由 on('close') 终止循环
        closed = true;
      }
    };

    // ── 3. abort + heartbeat wiring ─────────────────────────
    const abortCtl = new AbortController();
    let closed = false;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      if (!abortCtl.signal.aborted) abortCtl.abort();
      clearInterval(heartbeat);
      clearTimeout(streamTimeout);
      unsubscribeToolCall();
      unsubscribeAwareness();
    };
    raw.on('close', onClose);

    const heartbeat = setInterval(() => {
      if (closed) return;
      write(ssePing());
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const streamTimeout = setTimeout(() => {
      if (closed) return;
      abortCtl.abort();
    }, STREAM_TIMEOUT_MS);
    if (typeof streamTimeout.unref === 'function') streamTimeout.unref();

    // ── 4. wire tool_call envelope → SSE forward ─────────────
    const conversationId = body.conversationId;
    const unsubscribeToolCall = subscribeToolCallEvents((event) => {
      if (conversationId && event.conversationId && event.conversationId !== conversationId) return;
      try {
        write(sseEncode({ type: 'tool_call', messageId, event }));
      } catch {
        // ignore write errors — client 已断
      }
    });
    const conversationFilter = (envelope: unknown): boolean => {
      if (!conversationId) return true;
      if (!envelope || typeof envelope !== 'object') return true;
      const payload = (envelope as { payload?: unknown }).payload;
      if (!payload || typeof payload !== 'object') return true;
      const envelopeConvId = (payload as { conversationId?: unknown }).conversationId;
      if (typeof envelopeConvId !== 'string' || envelopeConvId.length === 0) return true;
      return envelopeConvId === conversationId;
    };
    const unsubscribeAwareness = deps.mainLoop
      ? deps.mainLoop.subscribeAwareness((envelope) => {
          if (closed) return;
          if (!conversationFilter(envelope)) return;
          write(sseEncode({ type: 'awareness', messageId, envelope }));
        })
      : () => undefined;

    // ── 5. emit message_start ───────────────────────────────
    write(sseEncode({
      type: 'message_start',
      messageId,
      model: provider,
      timestamp: Date.now(),
    }));

    // ── 5b. bind session (V6 主屏数据源) ─────────────────────
    sessionRegistry.bindCurrent(
      body.conversationId,
      provider,
      body.model ?? provider
    );
    if (deps.sessionRepo) {
      const sid = body.conversationId ?? `conv-${Date.now()}`;
      body.conversationId = sid;
      deps.sessionRepo.ensureSession({
        id: sid,
        title: body.message.slice(0, 50),
        provider,
        model: body.model ?? provider,
      });
      deps.sessionRepo.recordMessage({
        sessionId: sid,
        role: 'user',
        content: body.message,
      });
    }

    // ── 6. main: stream provider → text_delta ───────────────
    let finishReason: string | null = null;
    let sawError = false;
    let lastUsage: { promptTokens: number; completionTokens: number } | undefined;
    let assistantText = '';
    let totalToolCalls = 0;
    try {
      const messages: ChatMessage[] = [
        ...(body.systemPrompt
          ? [{ role: 'system' as const, content: body.systemPrompt }]
          : []),
        { role: 'user' as const, content: body.message },
      ];
      const toolSchemas = toolRegistry.list().map(toOpenAiTool);

      for (let turn = 0; turn <= MAX_TOOL_TURNS; turn += 1) {
        const toolCalls = new Map<number, { index: number; id?: string; name?: string; arguments: string }>();
        for await (const chunk of streamChat(provider, {
          messages,
          temperature: body.temperature,
          max_tokens: body.maxTokens,
          tools: toolSchemas,
          signal: abortCtl.signal,
        })) {
          if (chunk.delta) {
            assistantText += chunk.delta;
            write(sseEncode({
              type: 'text_delta',
              messageId,
              delta: chunk.delta,
            }));
          }
          for (const call of chunk.toolCalls ?? []) {
            const current = toolCalls.get(call.index) ?? {
              index: call.index,
              arguments: '',
            };
            if (call.id) current.id = call.id;
            if (call.name) current.name = call.name;
            if (call.arguments) current.arguments += call.arguments;
            toolCalls.set(call.index, current);
          }
          if (chunk.usage) {
            lastUsage = chunk.usage;
          }
          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }
          if (chunk.done) break;
        }
        if (closed) {
          throw new Error('stream closed');
        }
        if (toolCalls.size === 0) {
          if (closed) throw new Error('stream closed');
          break;
        }
        if (turn === MAX_TOOL_TURNS) {
          throw new Error('tool loop exceeded maximum turns');
        }

        const validCalls = [...toolCalls.values()].filter(
          (call): call is typeof call & { id: string; name: string } => Boolean(call.id && call.name),
        );
        messages.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: validCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        for (const call of validCalls) {
          totalToolCalls += 1;
          const tool = toolRegistry.get(call.name);
          const startedAt = Date.now();
          const parsedArgs = parseToolArguments(call.arguments);
          emitToolCall({
            type: 'tool_call_start',
            toolCallId: call.id,
            conversationId,
            name: call.name,
            displayName: tool?.displayName ?? call.name,
            displayDescription: tool?.displayDescription ?? '执行工具',
            args: parsedArgs.value,
            risk: tool?.risk,
            timestamp: startedAt,
          } satisfies ToolCallStartEvent);

          let result: unknown;
          let status: ToolCallResultEvent['status'] = 'success';
          let errorMessage: string | undefined;
          try {
            if (!tool) throw new Error(`Unknown tool: ${call.name}`);
            if (!parsedArgs.ok) {
              throw new Error('工具参数不是有效 JSON');
            }
            const decision = deps.mainLoop
              ? await deps.mainLoop.gateToolCall(tool, parsedArgs.value, { signal: abortCtl.signal })
              : tool.risk === 'high'
                ? { kind: 'deny' as const, reason: 'high-risk tool requires explicit approval' }
                : { kind: 'allow' as const };
            if (closed) throw new Error('stream closed');
            if (decision.kind !== 'allow') throw new Error(decision.reason ?? 'Tool permission denied');
            if (closed) throw new Error('stream closed');
            result = await tool.execute(parsedArgs.value);
            if (
              result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)
              && (result as { ok?: unknown }).ok === false
            ) {
              status = 'error';
              errorMessage = typeof (result as { error?: unknown }).error === 'string'
                ? (result as { error: string }).error
                : 'Tool returned a failure result';
            }
          } catch (err) {
            status = 'error';
            errorMessage = err instanceof Error ? err.message : String(err);
            result = { ok: false, error: errorMessage };
          }
          emitToolCall({
            type: 'tool_call_result',
            toolCallId: call.id,
            conversationId,
            result,
            durationMs: Date.now() - startedAt,
            status,
            errorMessage,
          } satisfies ToolCallResultEvent);
          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: call.id,
          });
        }
      }
    } catch (err) {
      sawError = true;
      if (!closed) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // 不暴露 internal stack — 给前端友好提示
        const friendly = friendlyStreamError(errMsg);
        write(sseEncode({
          type: 'error',
          messageId,
          code: 'stream_error',
          message: friendly,
          recoverable: !/auth|401|403/i.test(errMsg),
        }));
      }
    } finally {
      // ── 7. emit usage event + 累加到 session registry (V6 数据源) ──
      if (!closed && lastUsage) {
        const prompt = lastUsage.promptTokens;
        const completion = lastUsage.completionTokens;
        sessionRegistry.recordUsage({
          provider,
          model: body.model ?? provider,
          promptTokens: prompt,
          completionTokens: completion,
        });
        write(sseEncode({
          type: 'usage',
          messageId,
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: prompt + completion,
          provider,
          model: body.model ?? provider,
        }));
      }
      // ── 8. emit message_finish (always) ─────────────────────
      if (!closed) {
        if (!sawError) {
          write(sseEncode({
            type: 'message_finish',
            messageId,
            finishReason,
            timestamp: Date.now(),
          }));
        }
        if (deps.sessionRepo) {
          const sid = body.conversationId ?? `conv-${Date.now()}`;
          deps.sessionRepo.recordMessage({
            sessionId: sid,
            role: 'assistant',
            content: assistantText,
            promptTokens: lastUsage?.promptTokens,
            completionTokens: lastUsage?.completionTokens,
          });
          for (let i = 0; i < totalToolCalls; i += 1) {
            deps.sessionRepo.incrementToolCall(sid);
          }
          deps.sessionRepo.finishSession(sid);
        }
      }
      // ── 9. cleanup ─────────────────────────────────────────
      raw.off('close', onClose);
      unsubscribeToolCall();
      unsubscribeAwareness();
      clearInterval(heartbeat);
      clearTimeout(streamTimeout);
      if (!closed) {
        try { raw.end(); } catch { /* ignore */ }
      }
    }
  };
}

function toOpenAiTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function parseToolArguments(raw: string): { value: Record<string, unknown>; ok: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: {}, ok: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, ok: true };
    }
  } catch {
    // fall through
  }
  return { value: {}, ok: false };
}

function parseOk(parsed: { value: Record<string, unknown>; ok: boolean }): boolean {
  return parsed.ok;
}

// ── 错误友好化 (借鉴 chat-handler 的 toFriendlyMessage) ──────────
function friendlyStreamError(msg: string): string {
  if (/auth|401|403|invalid.*key|api.*key/i.test(msg)) return '访问密钥无效，请到设置里检查';
  if (/rate.*limit|429|too.*many/i.test(msg)) return '请求太频繁，请稍后再试';
  if (/network|fetch.*failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) return '连不上 AI 服务，请检查网络';
  if (/timeout|aborted/i.test(msg)) return 'AI 响应超时，请重试';
  return 'AI 服务暂不可用，请稍后再试';
}

// ── 单独暴露: GET /chat/stream/providers — 列出可用 provider ──────
export function createChatStreamMetaRoute() {
  return async function getProvidersHandler(): Promise<{
    providers: ModelProvider[];
    default: ModelProvider;
  }> {
    return {
      providers: listAvailableProviders(),
      default: listAvailableProviders().includes('deepseek') ? 'deepseek' : 'ollama',
    };
  };
}
