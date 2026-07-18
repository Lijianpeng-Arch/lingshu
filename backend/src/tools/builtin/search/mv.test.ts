import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runMv } from './mv.js';
import { setSandboxRoot } from '../../sandbox.js';

describe('mv', () => {
  let tmp: string;

  beforeEach(() => {
    setSandboxRoot(os.tmpdir());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-test-'));
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('moves a file', async () => {
    fs.writeFileSync(`${tmp}/a.txt`, 'x');
    const r = await runMv({ src: `${tmp}/a.txt`, dst: `${tmp}/b.txt` });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(`${tmp}/a.txt`)).toBe(false);
    expect(fs.readFileSync(`${tmp}/b.txt`, 'utf-8')).toBe('x');
  });

  it('renames a directory', async () => {
    fs.mkdirSync(`${tmp}/old`);
    fs.writeFileSync(`${tmp}/old/x.txt`, 'y');
    const r = await runMv({ src: `${tmp}/old`, dst: `${tmp}/new` });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(`${tmp}/old`)).toBe(false);
    expect(fs.existsSync(`${tmp}/new/x.txt`)).toBe(true);
  });

  it('rejects empty src', async () => {
    const r = await runMv({ src: '', dst: '/x' });
    expect(r.ok).toBe(false);
  });
});