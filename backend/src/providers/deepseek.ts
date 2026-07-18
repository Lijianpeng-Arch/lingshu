/**
 * DeepSeek Provider — OpenAI 兼容
 *
 * DeepSeek 的 API 完全兼容 OpenAI，所以直接用 OpenAI SDK
 * 默认 baseURL: https://api.deepseek.com
 * 默认模型: deepseek-chat
 */

import OpenAI from 'openai';
import {
  ChatResponseSchema,
  type Provider,
  type Capability,
  type ProviderConfig,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type ProbeResult,
} from './types.js';
import { OpenAICompatibleBase } from './base.js';
import { classifyError } from './errors.js';

export class DeepSeekProvider extends OpenAICompatibleBase implements Provider {
  readonly name = 'deepseek';
  readonly capabilities: ReadonlyArray<Capability> = ['chat', 'tool_use'];

  private client: OpenAI;

  constructor(config: ProviderConfig) {
    super(config);
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  canDo(capability: Capability): boolean {
    return this.capabilities.includes(capability);
  }

  async *chatStream(req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    try {
      const stream = await this.client.chat.completions.create({
        model: req.model ?? this.config.models?.chat ?? 'deepseek-chat',
        messages: req.messages as any,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: true,
        tools: req.tools as any,
      });
      for await (const chunk of stream as any) {
        const choice = chunk?.choices?.[0];
        const delta: string = choice?.delta?.content ?? '';
        const finishReason = choice?.finish_reason ?? null;
        yield { delta, done: false, finishReason };
      }
      yield { delta: '', done: true };
    } catch (err) {
      throw classifyError(err, this.name);
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      const completion = await this.client.chat.completions.create({
        model: req.model ?? this.config.models?.chat ?? 'deepseek-chat',
        messages: req.messages as any,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: false,
        tools: req.tools as any,
      });
      return ChatResponseSchema.parse(completion);
    } catch (err) {
      throw classifyError(err, this.name);
    }
  }

  async probe(): Promise<ProbeResult> {
    const start = Date.now();
    const model = this.config.probeModel ?? this.config.models?.chat ?? 'deepseek-chat';
    try {
      await this.client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
      });
      return {
        ok: true,
        provider: this.name,
        capabilities: [...this.capabilities],
        model,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const classified = classifyError(err, this.name);
      return { ok: false, provider: this.name, error: classified };
    }
  }
}