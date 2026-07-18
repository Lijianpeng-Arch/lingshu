import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './server.js';

describe('HTTP server', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    built = await buildApp({ skillsDir: '', skipMainLoop: true, quiet: true, dbPath: ':memory:' });
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    built.mainLoop.stop();
  });

  it('returns health status', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('rejects missing probe body', async () => {
    const response = await built.app.inject({ method: 'POST', url: '/api/providers/deepseek/probe' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for unknown provider', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/providers/unknown/probe',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('allows the localhost renderer origin through CORS', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('returns 404 when resolving an unknown permission id', async () => {
    const resolveSpy = vi.spyOn(built.mainLoop, 'resolvePermission');
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/permissions/perm-123/resolve',
      payload: { decision: 'allow' },
    });

    expect(resolveSpy).toHaveBeenCalledWith('perm-123', 'allow');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: 'permission_not_found' });
  });

  it('does not reflect an unknown CORS origin', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://unknown.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
