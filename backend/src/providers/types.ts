/**
 * Provider 类型 + Zod schemas
 * 灵枢 V2 — 多 LLM Provider 统一抽象
 */

import { z } from 'zod';

// ── Capability 枚举 ────────────────────────────────────────────
export const CapabilitySchema = z.enum([
  'chat',
  'embedding',
  'tool_use',
  'image',
  'tts',
  'stt',
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ChatToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});
export type ChatToolCall = z.infer<typeof ChatToolCallSchema>;

// ── Chat message (OpenAI 兼容) ────────────────────────────────
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ChatToolCallSchema).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.unknown()).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatChoiceSchema = z.object({
  index: z.number(),
  message: ChatMessageSchema,
  finish_reason: z.string().nullable(),
});

export const ChatResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  choices: z.array(ChatChoiceSchema).min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

// ── Provider config ───────────────────────────────────────────
export const ProviderConfigSchema = z.object({
  name: z.string().min(1),
  baseURL: z.string().url(),
  apiKey: z.string().min(1),
  capabilities: z.array(CapabilitySchema).min(1),
  models: z.record(z.string(), z.string()).optional(),
  probeModel: z.string().optional(),
  timeoutMs: z.number().int().positive().default(15_000),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ── Classified error（独立子 schema） ───────────────────────────
export const ClassifiedErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auth'), message: z.string(), statusCode: z.number().optional() }),
  z.object({
    kind: z.literal('rate_limit'),
    message: z.string(),
    retryAfterSec: z.number().optional(),
  }),
  z.object({ kind: z.literal('context_overflow'), message: z.string() }),
  z.object({ kind: z.literal('network'), message: z.string() }),
  z.object({
    kind: z.literal('retryable'),
    message: z.string(),
    statusCode: z.number().optional(),
  }),
  z.object({ kind: z.literal('unknown'), message: z.string(), statusCode: z.number().optional() }),
]);
export type ClassifiedError = z.infer<typeof ClassifiedErrorSchema>;

// ── Probe result（discriminated union） ────────────────────────
export const ProbeResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    provider: z.string(),
    capabilities: z.array(CapabilitySchema),
    model: z.string(),
    latencyMs: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    provider: z.string(),
    error: ClassifiedErrorSchema,
  }),
]);
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

// ── Streaming chunk ──────────────────────────────────────────
export interface ChatStreamChunk {
  delta: string;
  done: boolean;
  finishReason?: string | null;
}

// ── Provider 契约 ─────────────────────────────────────────────
export interface Provider {
  readonly name: string;
  readonly capabilities: ReadonlyArray<Capability>;
  canDo(capability: Capability): boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest): AsyncIterable<ChatStreamChunk>;
  probe(): Promise<ProbeResult>;
}
