import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runWriteFile } from './write_file.js';
import { setSandboxRoot } from '../../sandbox.js';

describe('write_file', () => {
  let tmp: string;

  beforeEach(() => {
    setSandboxRoot(os.tmpdir());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-test-'));
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('writes content to new file', async () => {
    const r = await runWriteFile({ path: `${tmp}/foo.txt`, content: 'hello' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(`${tmp}/foo.txt`, 'utf-8')).toBe('hello');
  });

  it('overwrites existing file', async () => {
    fs.writeFileSync(`${tmp}/foo.txt`, 'old');
    const r = await runWriteFile({ path: `${tmp}/foo.txt`, content: 'new' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(`${tmp}/foo.txt`, 'utf-8')).toBe('new');
  });

  it('creates parent directories', async () => {
    const r = await runWriteFile({ path: `${tmp}/a/b/c.txt`, content: 'x' });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(`${tmp}/a/b/c.txt`)).toBe(true);
  });

  it('rejects empty path', async () => {
    const r = await runWriteFile({ path: '', content: 'x' });
    expect(r.ok).toBe(false);
  });
});