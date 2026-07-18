/**
 * GET /api/providers + /api/providers/:name/models/:model
 *
 * 返回 4 个 provider 的详细列表 (含 available / currentModel / models[] / latencyMs).
 * 前端 ModelSelector 组件用.
 */
import type { FastifyInstance } from 'fastify';
import {
  listAvailableProviders,
  type ModelProvider,
} from '../models/registry.js';

interface ProviderInfo {
  provider: string;
  available: boolean;
  currentModel: string;
  models: Array<{
    name: string;
    label: string;
    contextWindow: number;
    inputPricePer1k: number;
    outputPricePer1k: number;
    capabilities: string[];
  }>;
  lastProbedAt: number | null;
  latencyMs: number | null;
}

const STATIC_TABLE: Record<
  ModelProvider,
  Array<{
    name: string;
    label: string;
    contextWindow: number;
    inputPricePer1k: number;
    outputPricePer1k: number;
    capabilities: string[];
  }>
> = {
  deepseek: [
    {
      name: 'deepseek-chat',
      label: 'DeepSeek Chat',
      contextWindow: 32_000,
      inputPricePer1k: 0.00014,
      outputPricePer1k: 0.00028,
      capabilities: ['chat', 'tool_use'],
    },
  ],
  openai: [
    {
      name: 'gpt-4o-mini',
      label: 'GPT-4o mini',
      contextWindow: 128_000,
      inputPricePer1k: 0.00015,
      outputPricePer1k: 0.0006,
      capabilities: ['chat', 'tool_use', 'vision'],
    },
    {
      name: 'gpt-4o',
      label: 'GPT-4o',
      contextWindow: 128_000,
      inputPricePer1k: 0.0025,
      outputPricePer1k: 0.01,
      capabilities: ['chat', 'tool_use', 'vision'],
    },
  ],
  anthropic: [
    {
      name: 'claude-3-5-sonnet',
      label: 'Claude 3.5 Sonnet',
      contextWindow: 200_000,
      inputPricePer1k: 0.003,
      outputPricePer1k: 0.015,
      capabilities: ['chat', 'tool_use', 'vision'],
    },
    {
      name: 'claude-3-haiku',
      label: 'Claude 3 Haiku',
      contextWindow: 200_000,
      inputPricePer1k: 0.00025,
      outputPricePer1k: 0.00125,
      capabilities: ['chat'],
    },
  ],
  ollama: [
    {
      name: 'qwen2.5:7b',
      label: 'Qwen 2.5 7B (本地)',
      contextWindow: 32_000,
      inputPricePer1k: 0,
      outputPricePer1k: 0,
      capabilities: ['chat'],
    },
  ],
};

export function createProvidersRoute(): (app: FastifyInstance) => void {
  return (app: FastifyInstance) => {
    app.get('/api/providers', async () => {
      const available = new Set(listAvailableProviders());
      const providers: ProviderInfo[] = (
        Object.keys(STATIC_TABLE) as ModelProvider[]
      ).map((p) => ({
        provider: p,
        available: available.has(p),
        currentModel: STATIC_TABLE[p][0].name,
        models: STATIC_TABLE[p],
        lastProbedAt: null,
        latencyMs: null,
      }));
      return providers;
    });

    app.get<{ Params: { name: string; model: string } }>(
      '/api/providers/:name/models/:model',
      async (req, reply) => {
        const { name, model } = req.params;
        const provider = (Object.keys(STATIC_TABLE) as ModelProvider[]).find(
          (p) => p === name
        );
        if (!provider) {
          reply.code(404);
          return { error: `Provider "${name}" not found` };
        }
        const m = STATIC_TABLE[provider].find((x) => x.name === model);
        if (!m) {
          reply.code(404);
          return { error: `Model "${model}" not found on ${name}` };
        }
        return {
          provider: name,
          model: m.name,
          label: m.label,
          maxTokens: 4096,
          temperature: 0.7,
          supportsTools: m.capabilities.includes('tool_use'),
          supportsVision: m.capabilities.includes('vision'),
          supportsStreaming: true,
          description: `${m.label} — ${m.contextWindow.toLocaleString()} tokens 上下文`,
        };
      }
    );
  };
}