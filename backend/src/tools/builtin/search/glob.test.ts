import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runGlob } from './glob.js';

describe('glob', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-glob-'));
    fs.mkdirSync(`${tmp}/src`);
    fs.mkdirSync(`${tmp}/node_modules`);
    fs.writeFileSync(`${tmp}/src/a.ts`, 'x');
    fs.writeFileSync(`${tmp}/src/b.ts`, 'y');
    fs.writeFileSync(`${tmp}/src/c.txt`, 'z');
    fs.writeFileSync(`${tmp}/node_modules/skip.ts`, 'skip');
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('finds files matching pattern', async () => {
    const r = await runGlob({ pattern: 'src/*.ts', cwd: tmp });
    expect(r.ok).toBe(true);
    const out = (r as any).output as string;
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
    expect(out).not.toContain('c.txt');
    expect((r as any).count).toBe(2);
  });

  it('ignores node_modules by default', async () => {
    const r = await runGlob({ pattern: '**/*.ts', cwd: tmp });
    expect(r.ok).toBe(true);
    expect((r as any).output).not.toContain('node_modules');
  });

  it('rejects empty pattern', async () => {
    const r = await runGlob({ pattern: '' });
    expect(r.ok).toBe(false);
  });

  it('truncates output and appends NOTE when matches exceed MAX_GLOB_ENTRIES (M12)', async () => {
    // Mock fast-glob to return more than MAX_GLOB_ENTRIES (10_000) without disk I/O.
    vi.resetModules();
    vi.doMock('fast-glob', () => ({
      default: async () => Array.from({ length: 10_001 }, (_, i) => `f${i}.ts`),
    }));
    const { runGlob: runGlobStub } = await import('./glob.js');
    const r = await runGlobStub({ pattern: '*.ts', cwd: tmp });
    vi.doUnmock('fast-glob');
    vi.resetModules();
    expect(r.ok).toBe(true);
    expect((r as any).output).toContain('Output truncated: showing first 10000');
    expect((r as any).count).toBe(10_000);
  });
});
