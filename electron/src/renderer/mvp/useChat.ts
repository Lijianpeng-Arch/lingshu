/**
 * useChat — 统一聊天 hook (融合 Phase 1, 2026-07-18)
 *
 * 调用 POST /chat/stream (灵枢统一聊天通道, V6 底座), 返回:
 * - messages: 当前会话消息列表
 * - send(text): 发送新消息,触发流式接收
 * - isStreaming: 正在接收 AI 回复
 * - error: 上一次错误
 *
 * SSE 契约见 @lingshu/shared-types ChatStreamEvent:
 *   message_start → text_delta* → (usage?) → message_finish, 出错走 error。
 * Phase 1 只渲染 text_delta + error; tool_call / usage 收到即忽略 (v0.2 点亮)。
 */
import { useCallback, useRef, useState } from 'react';
import type { MessageItemData } from './MessageItem';
import type { ChatStreamEvent, ChatStreamProvider } from '@lingshu/shared-types';

export interface ChatSelection {
  provider: string;
  model: string;
}

export interface UseChatOptions {
  sessionId?: string;
  apiBase?: string;
}

interface UseChatResult {
  messages: MessageItemData[];
  send: (text: string, selection: ChatSelection) => Promise<void>;
  isStreaming: boolean;
  error: string | null;
  clear: () => void;
}

/** 真实可用的 provider 白名单 (与后端 ModelProvider 对齐). 'mock'/未知 → 让后端自选默认. */
const REAL_PROVIDERS: ChatStreamProvider[] = ['deepseek', 'openai', 'anthropic', 'ollama'];
function toModel(provider: string): ChatStreamProvider | undefined {
  return (REAL_PROVIDERS as string[]).includes(provider)
    ? (provider as ChatStreamProvider)
    : undefined;
}

export function useChat(opts: UseChatOptions = {}): UseChatResult {
  const [messages, setMessages] = useState<MessageItemData[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** SSE parse 失败计数 — 累计 > 5 时 setError, 避免 silent corrupt */
  const parseErrorCount = useRef(0);

  const send = useCallback(
    async (text: string, selection: ChatSelection) => {
      setError(null);
      const trimmed = text.trim();
      if (!trimmed) return;

      const sessionId = opts.sessionId ?? 'default';
      const userMsg: MessageItemData = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
      };
      const assistantId = `assistant-${Date.now()}`;
      const assistantMsg: MessageItemData = {
        id: assistantId,
        role: 'assistant',
        content: '',
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const apiBase = opts.apiBase ?? '';
        const res = await fetch(`${apiBase}/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            // 'mock'/未知 provider → 省略 model, 让后端选默认 (走真 LLM 或诚实报错, 不再 mock 回显)
            model: toModel(selection.provider),
            conversationId: sessionId,
          }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            // 心跳注释行 ": ping" — 无 data: 前缀, 忽略
            let dataLine = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('data: ')) dataLine = line.slice(6);
              else if (line.startsWith('data:')) dataLine = line.slice(5);
            }
            if (!dataLine) continue;

            let evt: ChatStreamEvent;
            try {
              evt = JSON.parse(dataLine) as ChatStreamEvent;
            } catch (e) {
              // 部分 chunk 截断导致的 parse 错误属正常, 但连续 > 5 个就提示
              parseErrorCount.current += 1;
              if (parseErrorCount.current > 5) {
                setError('消息流异常, 请重试');
              }
              // eslint-disable-next-line no-console
              console.warn('SSE parse error:', e);
              continue;
            }

            switch (evt.type) {
              case 'text_delta':
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: m.content + evt.delta } : m,
                  ),
                );
                break;
              case 'error':
                setError(evt.message);
                break;
              // message_start / message_finish: 无需处理, 流自然结束
              // tool_call / usage / awareness: Phase 1 忽略, v0.2 点亮
              default:
                break;
            }
          }
        }
      } catch (e: unknown) {
        const err = e as Error;
        if (err.name === 'AbortError') {
          // 用户主动停止:不做 error 处理
        } else {
          // 错误消息 fallback: e 可能是 string / null / Error, 避免显示 '未知错误'
          const fallback = (() => {
            if (err && typeof err.message === 'string' && err.message.length > 0) return err.message;
            if (typeof e === 'string' && e.length > 0) return e;
            try {
              const s = String(e);
              if (s && s !== '[object Object]') return s;
            } catch {
              /* fall through */
            }
            return '未知错误';
          })();
          setError(fallback);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [opts.sessionId, opts.apiBase],
  );

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setIsStreaming(false);
  }, []);

  return { messages, send, isStreaming, error, clear };
}