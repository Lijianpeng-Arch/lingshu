/**
 * Model Registry — 多模型统一抽象
 *
 * 4 个 provider 复用 fetch 直打各家 API,不引入新 SDK:
 *   - deepseek  → OpenAI 兼容 (https://api.deepseek.com/v1/chat/completions)
 *   - openai    → OpenAI 兼容 (https://api.openai.com/v1/chat/completions)
 *   - claude    → 原生 Anthropic messages API (https://api.anthropic.com/v1/messages)
 *   - ollama    → OpenAI 兼容 (http://localhost:11434/v1/chat/completions)
 *
 * 借鉴 Vercel AI SDK 的统一语言模型接口,但只暴露 chatStream 一条管道,
 * 跟现有 chat-handler 配合。
 *
 * 设计原则:
 *   - 不破坏现有 deepseek provider (向后兼容)
 *   - 不引入 npm 依赖 (用 fetch)
 *   - 每个 provider 提供 streaming SSE + non-streaming 两条路径
 *   - 鉴权走 env + 启动时 recall, 不写盘
 */

import type { ChatMessage } from '../providers/types.js';

// ── Provider + Config types ──────────────────────────────────────
export type ModelProvider = 'deepseek' | 'openai' | 'anthropic' | 'ollama';

export interface ModelConfig {
  provider: ModelProvider;
  /** 模型名 — 各家各自识别 (e.g. 'gpt-4o' / 'claude-3-5-sonnet-20241022' / 'deepseek-chat') */
  model: string;
  /** API key (ollama 用 'ollama' 占位即可) */
  apiKey: string;
  /** 自定义 base URL, ollama 必填 */
  baseUrl?: string;
  /** 是否可用 (env 没设就是 false) */
  available: boolean;
}

// ── Static presets — 启动时按 env 算 availability ─────────────
function envKey(name: string): string {
  // 后端历史上用 LINGSHU_DEEPSEEK_API_KEY, OpenAI 用 OPENAI_API_KEY 是行业惯例。
  // Claude 历史上用 ANTHROPIC_API_KEY。
  return process.env[name] ?? '';
}

function readEnv(name: string): string {
  return process.env[name] ?? '';
}

/**
 * Compute the current ModelConfig list from env state.
 *
 * 每次调用都重读 process.env, 方便测试单独 set env。
 * 生产环境启动时调一次缓存到 MODEL_PRESETS 也 OK, 但默认每次重读保持简单。
 */
export function readModelPresets(): ModelConfig[] {
  return [
    {
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: readEnv('LINGSHU_DEEPSEEK_API_KEY') || readEnv('DEEPSEEK_API_KEY'),
      baseUrl: readEnv('LINGSHU_DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/v1',
      available: !!(readEnv('LINGSHU_DEEPSEEK_API_KEY') || readEnv('DEEPSEEK_API_KEY')),
    },
    {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: readEnv('OPENAI_API_KEY'),
      baseUrl: readEnv('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
      available: !!readEnv('OPENAI_API_KEY'),
    },
    {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: readEnv('ANTHROPIC_API_KEY'),
      baseUrl: readEnv('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com',
      available: !!readEnv('ANTHROPIC_API_KEY'),
    },
    {
      provider: 'ollama',
      model: readEnv('OLLAMA_MODEL') || 'llama3.1',
      apiKey: 'ollama',
      baseUrl: readEnv('OLLAMA_BASE_URL') || 'http://localhost:11434/v1',
      available: true,
    },
  ];
}

// 兼容老 API (eager 单次 load)。但不靠它做可用判断, 看 availability 用 readModelPresets().
export const MODEL_PRESETS: ModelConfig[] = readModelPresets();

/** 按 provider 查找 preset config。未注册时返回 undefined。 */
export function getModel(provider: ModelProvider): ModelConfig | undefined {
  return readModelPresets().find((m) => m.provider === provider);
}

/** 列出所有已注册的 provider (含未配置 key 的, 排除 deepseek-only 历史限制) */
export function listModels(): ModelConfig[] {
  return readModelPresets();
}

// ── 统一聊天输入 (与 chat-handler 兼容) ───────────────────────────
export interface UnifiedChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** 流式 (default: true) */
  stream?: boolean;
  /** 可选 abort signal */
  signal?: AbortSignal;
}

// ── Streaming chunk 抽象 (V6 SSE 协议最简形态) ───────────────────
export interface UnifiedChatChunk {
  delta: string;
  done: boolean;
  /** Stop reason — 用各家的原文 (stop / end_turn / tool_use ...) */
  finishReason?: string | null;
  /**
   * Token 消耗 (仅 done=true 时有, 用作 SSE usage event + sessionRegistry 累加).
   * OpenAI: usage.prompt_tokens / completion_tokens
   * Claude: message_delta.usage.input_tokens / output_tokens
   */
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

// ── OpenAI 兼容 (deepseek/openai/ollama) ────────────────────────
async function* streamOpenAICompatible(
  cfg: ModelConfig,
  req: UnifiedChatRequest
): AsyncIterable<UnifiedChatChunk> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model ?? cfg.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        name: m.name,
      })),
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream: true,
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Provider ${cfg.provider} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastUsage: UnifiedChatChunk['usage'];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE-style "data: ..." lines.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          yield { delta: '', done: true, finishReason: 'stop', usage: lastUsage };
          continue;
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const choice = parsed.choices?.[0];
          // OpenAI 风格: usage 在最后一个 chunk (done=true 之前) 出现
          if (parsed.usage) {
            lastUsage = {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            };
          }
          if (choice) {
            const delta = choice.delta?.content ?? '';
            yield {
              delta,
              done: false,
              finishReason: choice.finish_reason ?? null,
            };
          }
        } catch {
          // malformed line; skip
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// ── Anthropic Messages API (claude) ──────────────────────────────
async function* streamClaude(
  cfg: ModelConfig,
  req: UnifiedChatRequest
): AsyncIterable<UnifiedChatChunk> {
  // Anthropic 用独立的 system 字段,需要 split 出来
  const systemParts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
    // tool messages 不直接支持,跳过 (TODO: 真接入 tool_use 时再处理)
  }

  const url = `${cfg.baseUrl}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: req.model ?? cfg.model,
      system: systemParts.join('\n\n') || undefined,
      messages,
      max_tokens: req.max_tokens ?? 1024,
      temperature: req.temperature,
      stream: true,
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Provider claude HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;
  let lastUsage: UnifiedChatChunk['usage'];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        try {
          const parsed = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string };
            message?: { stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            yield {
              delta: parsed.delta.text ?? '',
              done: false,
              finishReason: null,
            };
          } else if (parsed.type === 'message_delta') {
            finishReason = parsed.message?.stop_reason ?? finishReason;
            // Anthropic message_delta 带 usage (input_tokens/output_tokens)
            if (parsed.usage) {
              lastUsage = {
                promptTokens: parsed.usage.input_tokens ?? 0,
                completionTokens: parsed.usage.output_tokens ?? 0,
              };
            }
          } else if (parsed.type === 'message_stop') {
            yield { delta: '', done: true, finishReason, usage: lastUsage };
            return;
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  yield { delta: '', done: true, finishReason };
}

// ── 路由 ─────────────────────────────────────────────────────────
export async function* streamChat(
  provider: ModelProvider,
  req: UnifiedChatRequest
): AsyncIterable<UnifiedChatChunk> {
  const cfg = getModel(provider);
  if (!cfg) throw new Error(`Unknown model provider: ${provider}`);
  if (!cfg.available && provider !== 'ollama') {
    throw new Error(
      `Model provider "${provider}" is not configured. Set ${providerNameToEnvKey(provider)} in env.`,
    );
  }
  switch (provider) {
    case 'deepseek':
    case 'openai':
    case 'ollama':
      yield* streamOpenAICompatible(cfg, req);
      return;
    case 'anthropic':
      yield* streamClaude(cfg, req);
      return;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

function providerNameToEnvKey(provider: ModelProvider): string {
  switch (provider) {
    case 'deepseek': return 'LINGSHU_DEEPSEEK_API_KEY (or DEEPSEEK_API_KEY)';
    case 'openai': return 'OPENAI_API_KEY';
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'ollama': return 'OLLAMA_BASE_URL';
    default: return provider;
  }
}

/** 列出可用 provider names (env 装了 key 的, ollama 永远算 available) */
export function listAvailableProviders(): ModelProvider[] {
  return readModelPresets().filter((m) => m.available).map((m) => m.provider);
}
