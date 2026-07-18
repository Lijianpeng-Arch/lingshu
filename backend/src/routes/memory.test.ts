import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';

describe('POST /api/memory/* (MVP)', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  const dbPath = ':memory:';

  beforeAll(async () => {
    process.env.LINGSHU_DB_PATH = dbPath;
    built = await buildApp({
      skillsDir: '',
      skipMainLoop: true,
      quiet: true,
      dbPath,
    });
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    built.mainLoop.stop();
  });

  it('recall with empty messages returns empty', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/memory/recall',
      payload: { recentMessages: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { facts: string[] };
    expect(body.facts).toEqual([]);
  });

  it('store + recall roundtrip', async () => {
    const store = await built.app.inject({
      method: 'POST',
      url: '/api/memory/store',
      payload: { fact: '用户电脑 D 盘是工作盘' },
    });
    expect(store.statusCode).toBe(200);

    const recall = await built.app.inject({
      method: 'POST',
      url: '/api/memory/recall',
      payload: { recentMessages: ['我电脑 D 盘有什么'] },
    });
    expect(recall.statusCode).toBe(200);
    const body = recall.json() as { facts: string[] };
    expect(body.facts.length).toBeGreaterThan(0);
    expect(body.facts[0]).toContain('D 盘');
  });
});