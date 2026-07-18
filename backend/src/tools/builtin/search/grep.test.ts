import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runGrep } from './grep.js';

const HAS_RG = spawnSync('rg', ['--version']).status === 0;

describe('grep', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-grep-'));
    fs.writeFileSync(`${tmp}/a.txt`, 'hello world\nfoo bar\n');
    fs.writeFileSync(`${tmp}/b.txt`, 'goodbye world\n');
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it.runIf(HAS_RG)('finds matches in files', async () => {
    const r = (await runGrep({ pattern: 'world', path: tmp })) as { ok: boolean; output?: string };
    expect(r.ok).toBe(true);
    expect(r.output).toContain('a.txt');
    expect(r.output).toContain('b.txt');
  });

  it.runIf(HAS_RG)('returns (no matches) when nothing found', async () => {
    const r = (await runGrep({ pattern: 'this-string-does-not-exist-xyz', path: tmp })) as { ok: boolean; output?: string };
    expect(r.ok).toBe(true);
    expect(r.output).toBe('(no matches)');
  });

  it.runIf(HAS_RG)('supports include filter', async () => {
    fs.writeFileSync(`${tmp}/c.ts`, 'world again\n');
    const r = (await runGrep({ pattern: 'world', path: tmp, include: '*.ts' })) as { ok: boolean; output?: string };
    expect(r.ok).toBe(true);
    expect(r.output).toContain('c.ts');
    expect(r.output).not.toContain('a.txt');
  });

  it('rejects empty pattern', async () => {
    const r = (await runGrep({ pattern: '' })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });
});