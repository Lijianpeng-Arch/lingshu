/**
 * MVP /api/settings — 设置 CRUD + test-key probe
 *
 * GET   /api/settings         — 全量返回 (含 availableProviders)
 * PATCH /api/settings         — 部分更新 (apiKeys 深合并)
 * POST  /api/settings/test-key — 用给定 key 试调 provider probe
 *
 * 存储: ~/.lingshu/settings.json (明文, MVP 接受)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadSettings, saveSettings } from '../permission/settings.js';
import { listAvailableProviders } from '../models/registry.js';
import { classifyError } from '../providers/errors.js';

const ALLOWED_PROVIDERS = ['deepseek', 'openai', 'anthropic', 'ollama', 'mock'] as const;

const PatchBodySchema = z.object({
  mode: z.enum(['smart', 'plan', 'goal']).optional(),
  permissionTimeoutSeconds: z.number().int().positive().optional(),
  apiKeys: z.object({
    deepseek: z.string().optional(),
    openai: z.string().optional(),
    anthropic: z.string().optional(),
    ollama: z.string().optional(),
  }).optional(),
  currentProvider: z.enum(ALLOWED_PROVIDERS).optional(),
  currentModel: z.string().min(1).optional(),
  workspaceDir: z.string().min(1).optional(),
  shellCwd: z.string().min(1).optional(),
});

const TestKeyBodySchema = z.object({
  provider: z.enum(['deepseek', 'openai', 'anthropic', 'ollama']),
  apiKey: z.string().min(1),
});

/**
 * shallowMerge — MVP 设置 apiKeys 合并
 *
 * MVP 阶段: settings.apiKeys 是一层结构 (deepseek / openai / anthropic / ollama),
 * 一层 spread 即可, 无需递归。命名故意保留 "shallow" 后缀以提醒:
 * - 未来如果加 nested 结构 (例如 perProvider 配置), 必须升级为 deep merge
 * - 不要在 v0.2+ 之前误用为通用深合并
 */
function shallowMerge<T extends Record<string, any>>(base: T | undefined, patch: Partial<T> | undefined): T {
  return { ...(base ?? {}), ...(patch ?? {}) } as T;
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async () => {
    const s = loadSettings();
    return {
      ...s,
      availableProviders: listAvailableProviders(),
    };
  });

  app.patch('/api/settings', async (req, reply) => {
    const parsed = PatchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.message };
    }
    const current = loadSettings();
    const patch = parsed.data;
    const next = {
      ...current,
      ...patch,
      // apiKeys 浅合并 (单层结构)
      apiKeys: shallowMerge(current.apiKeys, patch.apiKeys),
    };
    saveSettings(next);
    return { ...next, availableProviders: listAvailableProviders() };
  });

  app.post<{ Body: z.infer<typeof TestKeyBodySchema> }>(
    '/api/settings/test-key',
    async (req) => {
      const parsed = TestKeyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_request', message: parsed.error.message };
      }
      const { provider, apiKey } = parsed.data;

      // 简单 probe: 用 fetch 直打各家 /chat/completions (OpenAI 兼容)
      // MVP 阶段够用, v0.2 复用 Provider.probe()
      const baseUrls: Record<string, string> = {
        deepseek: 'https://api.deepseek.com/v1',
        openai: 'https://api.openai.com/v1',
        anthropic: 'https://api.anthropic.com',
        ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
      };
      const url = baseUrls[provider];
      const start = Date.now();

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        let body: Record<string, unknown>;
        if (provider === 'anthropic') {
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
          body = {
            model: 'claude-3-haiku-20240307',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
          };
          const res = await fetch(`${url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: classifyError(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), provider).kind, message: text.slice(0, 200) };
          }
        } else {
          headers['Authorization'] = `Bearer ${apiKey}`;
          body = {
            model: provider === 'ollama' ? (process.env.OLLAMA_MODEL || 'llama3.1') : (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'),
            messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
            max_tokens: 8,
          };
          const res = await fetch(`${url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: classifyError(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), provider).kind, message: text.slice(0, 200) };
          }
        }
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: classifyError(err, provider).kind, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}