import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSkillRoutes } from './routes.js';

let app: ReturnType<typeof Fastify>;
let root: string;

async function sourceWithManifest(manifest: Record<string, unknown>) {
  const sourceDir = path.join(root, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify(manifest));
  return sourceDir;
}

afterEach(async () => { await app?.close(); await fs.rm(root, { recursive: true, force: true }); });

describe('skill routes', () => {
  it('inspects a local skill through HTTP', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-routes-'));
    const sourceDir = await sourceWithManifest({ name: 'weather-query', description: 'Get weather', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    app = Fastify();
    await app.register(createSkillRoutes({ getProvider: () => { throw new Error('not needed'); } }));
    const response = await app.inject({ method: 'POST', url: '/api/skills/inspect-local', payload: { sourceDir } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, inspection: { name: 'weather-query', needsChinese: true } });
  }, 30_000);

  it('uses the injected provider for translation preview', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-routes-'));
    const sourceDir = await sourceWithManifest({ name: 'weather-query', description: 'Get weather', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    const provider = { chatStream: async function* () { yield { delta: '天气查询|查询天气' }; } };
    app = Fastify();
    await app.register(createSkillRoutes({ getProvider: () => provider as any }));
    const response = await app.inject({ method: 'POST', url: '/api/skills/preview-translation', payload: { sourceDir } });
    expect(response.json()).toEqual({ ok: true, displayName: '天气查询', description: '查询天气' });
  });

  it('returns manual fallback as HTTP 200 when provider is unavailable', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-routes-'));
    const sourceDir = await sourceWithManifest({ name: 'weather-query', description: 'Get weather', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    app = Fastify();
    await app.register(createSkillRoutes({ getProvider: () => { throw new Error('offline'); } }));
    const response = await app.inject({ method: 'POST', url: '/api/skills/preview-translation', payload: { sourceDir } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, needsManual: true });
  });
});
