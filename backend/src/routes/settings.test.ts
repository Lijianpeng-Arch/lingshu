import { afterAll, beforeAll, describe, expect, it, vi, beforeEach } from 'vitest';
import { buildApp } from '../server.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const TMP_SETTINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-settings-test-'));
const TMP_SETTINGS_PATH = path.join(TMP_SETTINGS_DIR, 'settings.json');

describe('GET /api/settings', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    vi.stubEnv('LINGSHU_SETTINGS_PATH', TMP_SETTINGS_PATH);
    built = await buildApp({ skillsDir: '', skipMainLoop: true, quiet: true, dbPath: ':memory:' });
    await built.app.ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await built.app.close();
    built.mainLoop.stop();
  });

  it('returns full settings with availableProviders', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.mode).toBe('smart');
    expect(body.apiKeys).toBeDefined();
    expect(body.currentProvider).toBeDefined();
    expect(body.workspaceDir).toBeDefined();
    expect(Array.isArray(body.availableProviders)).toBe(true);
  });
});

describe('PATCH /api/settings', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    vi.stubEnv('LINGSHU_SETTINGS_PATH', TMP_SETTINGS_PATH);
    built = await buildApp({ skillsDir: '', skipMainLoop: true, quiet: true, dbPath: ':memory:' });
    await built.app.ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await built.app.close();
    built.mainLoop.stop();
    fs.rmSync(TMP_SETTINGS_DIR, { recursive: true, force: true });
  });

  it('updates single field and returns full settings', async () => {
    const res = await built.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { currentProvider: 'ollama', currentModel: 'qwen2.5:7b' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.currentProvider).toBe('ollama');
    expect(body.currentModel).toBe('qwen2.5:7b');
  });

  it('deep-merges apiKeys (preserves other keys)', async () => {
    // 先设 deepseek
    await built.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { apiKeys: { deepseek: 'sk-original' } },
    });
    // 再 PATCH openai
    const res = await built.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { apiKeys: { openai: 'sk-new' } },
    });
    const body = JSON.parse(res.body);
    expect(body.apiKeys.deepseek).toBe('sk-original');
    expect(body.apiKeys.openai).toBe('sk-new');
  });

  it('returns 400 on invalid provider', async () => {
    const res = await built.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { currentProvider: 'invalid-provider' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/settings/test-key', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    vi.stubEnv('LINGSHU_DEEPSEEK_API_KEY', 'sk-test');
    vi.stubEnv('LINGSHU_SETTINGS_PATH', TMP_SETTINGS_PATH);
    built = await buildApp({ skillsDir: '', skipMainLoop: true, quiet: true, dbPath: ':memory:' });
    await built.app.ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await built.app.close();
    built.mainLoop.stop();
  });

  beforeEach(() => {
    // mock fetch 模拟成功
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200 })
    ));
  });

  it('returns ok=true when probe succeeds', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/settings/test-key',
      payload: { provider: 'deepseek', apiKey: 'sk-test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok=false with auth error on 401', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{"err":"bad key"}', { status: 401 })
    ));
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/settings/test-key',
      payload: { provider: 'deepseek', apiKey: 'sk-bad' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
  });
});