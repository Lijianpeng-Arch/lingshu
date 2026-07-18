import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';

/**
 * MVP /api/providers — 复用 routes/v6/providers.ts (MVP 启动时从 V6 时代继承的路由)
 * 路由返回 ProviderInfo[] 直接数组, 不包 { providers: [...] }
 * MVP 前端按此格式读
 */
describe('GET /api/providers (MVP)', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    built = await buildApp({
      skillsDir: '',
      skipMainLoop: true,
      quiet: true,
      dbPath: ':memory:',
    });
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    built.mainLoop.stop();
  });

  it('returns 4 providers (deepseek, openai, claude, ollama via V6 route)', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ provider: string; models: unknown[] }>;
    expect(Array.isArray(body)).toBe(true);
    const names = body.map((p) => p.provider);
    // V6 静态表里的 4 个 provider key
    expect(names).toContain('openai');
    expect(names).toContain('deepseek');
    expect(names).toContain('anthropic');
    expect(names).toContain('ollama');
  });

  it('each provider has at least one model', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/providers' });
    const body = res.json() as Array<{ provider: string; models: unknown[] }>;
    for (const p of body) {
      expect(p.models.length).toBeGreaterThanOrEqual(1);
    }
  });
});