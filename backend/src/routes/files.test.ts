import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';

describe('POST /api/files/* (MVP)', () => {
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

  it('sandbox root exists', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/files/sandbox' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { root: string };
    expect(body.root).toMatch(/sandbox/);
  });

  it('list returns directory entries', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/files/list',
      payload: { path: '.' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('list rejects absolute path', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/files/list',
      payload: { path: 'C:\\Windows' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('read returns file content', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/files/write',
      payload: {
        path: 'test-read.txt',
        content: 'hello world',
        confirmToken: 'approved',
      },
    });
    expect(res.statusCode).toBe(200);

    const r2 = await built.app.inject({
      method: 'POST',
      url: '/api/files/read',
      payload: { path: 'test-read.txt' },
    });
    expect(r2.statusCode).toBe(200);
    const body = r2.json() as { content: string };
    expect(body.content).toBe('hello world');
  });

  it('write without confirmToken returns 403', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/files/write',
      payload: { path: 'no-confirm.txt', content: 'should fail' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('search finds matching file', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/files/write',
      payload: {
        path: 'search-target.md',
        content: 'line 1: not match\nline 2: hello world\nline 3: bye',
        confirmToken: 'approved',
      },
    });
    expect(res.statusCode).toBe(200);

    const r2 = await built.app.inject({
      method: 'POST',
      url: '/api/files/search',
      payload: { path: '.', query: 'hello world' },
    });
    expect(r2.statusCode).toBe(200);
    const body = r2.json() as { results: Array<{ path: string }> };
    expect(body.results.some((r) => r.path === 'search-target.md')).toBe(true);
  });
});