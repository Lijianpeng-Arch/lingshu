import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../server.js';
import * as childProcess from 'node:child_process';

describe('POST /api/commands/run (MVP)', () => {
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

  it('rejects empty command', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/commands/run',
      payload: { command: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects rm -rf /', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/commands/run',
      payload: { command: 'rm -rf /', confirmToken: 'approved' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects format C:', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/commands/run',
      payload: { command: 'format C:', confirmToken: 'approved' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects diskpart', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/commands/run',
      payload: { command: 'diskpart', confirmToken: 'approved' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects non-blacklist without confirmToken', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/commands/run',
      payload: { command: 'echo hello' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('runs echo hello with confirmToken', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/commands/run',
      payload: { command: 'echo hello', confirmToken: 'approved' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; stdout: string };
    expect(body.ok).toBe(true);
    expect(body.stdout).toContain('hello');
  });

  // ── P0-2: Windows 进程杀不掉 (taskkill /F /T) ─────────────────
  describe('P0-2: killProc cross-platform', () => {
    it('killProc uses taskkill /pid /F /T on win32', async () => {
      vi.resetModules();
      const execMock = vi.fn((_cmd: string, _cb: any) => {});
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof childProcess>('node:child_process');
        return { ...actual, exec: execMock as any };
      });
      const commandsMod = await import('./commands.js');
      const fakeProc = { pid: 99999 } as childProcess.ChildProcess;
      commandsMod.killProc(fakeProc);
      await new Promise((r) => setTimeout(r, 10));
      if (process.platform === 'win32') {
        expect(execMock).toHaveBeenCalled();
        const cmd = String(execMock.mock.calls[0][0]);
        expect(cmd).toContain('taskkill');
        expect(cmd).toContain('/pid 99999');
        expect(cmd).toContain('/F');
        expect(cmd).toContain('/T');
      } else {
        expect(execMock).not.toHaveBeenCalled();
      }
      vi.doUnmock('node:child_process');
      vi.resetModules();
    });
  });

  // ── P1-4: 黑名单补 4 条 Windows 破坏性命令 ───────────────────
  describe('P1-4: Windows blacklist', () => {
    it('rejects reg delete (改注册表)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/commands/run',
        payload: { command: 'reg delete HKLM\\Software\\Test', confirmToken: 'approved' },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string };
      expect(body.error).toContain('注册表');
    });

    it('rejects bcdedit (改启动配置)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/commands/run',
        payload: { command: 'bcdedit /set {bootmgr} displaybootmenu yes', confirmToken: 'approved' },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string };
      expect(body.error).toContain('启动配置');
    });

    it('rejects cipher /w (擦盘)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/commands/run',
        payload: { command: 'cipher /w:C:\\', confirmToken: 'approved' },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string };
      expect(body.error).toContain('擦盘');
    });

    it('rejects net user (改账户)', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/commands/run',
        payload: { command: 'net user hacker P@ssw0rd /add', confirmToken: 'approved' },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string };
      expect(body.error).toContain('账户');
    });
  });

  // ── P1-5: spawn 同步抛 → 503 而非 500 ─────────────────────────
  describe('P1-5: spawn try/catch', () => {
    it('returns 503 when spawn throws synchronously (PATH missing / EACCES)', async () => {
      vi.resetModules();
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof childProcess>('node:child_process');
        return {
          ...actual,
          spawn: vi.fn(() => {
            throw new Error('spawn ENOENT (test mock)');
          }),
        };
      });
      const commandsMod = await import('./commands.js');
      const fastify = (await import('fastify')).default();
      await fastify.register(commandsMod.commandsRoutes);
      await fastify.ready();

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/commands/run',
        payload: {
          command: 'echo hello',
          confirmToken: 'approved',
        },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { ok: boolean; error: string; message: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe('spawn failed');
      expect(body.message).toContain('spawn ENOENT');

      vi.doUnmock('node:child_process');
      vi.resetModules();
      await fastify.close();
    });
  });
});