import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCp } from './cp.js';
import { setSandboxRoot } from '../../sandbox.js';

describe('cp', () => {
  let tmp: string;

  beforeEach(() => {
    setSandboxRoot(os.tmpdir());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-test-'));
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('copies a file', async () => {
    fs.writeFileSync(`${tmp}/a.txt`, 'hello');
    const r = await runCp({ src: `${tmp}/a.txt`, dst: `${tmp}/b.txt` });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(`${tmp}/b.txt`, 'utf-8')).toBe('hello');
  });

  it('copies a directory recursively', async () => {
    fs.mkdirSync(`${tmp}/src`);
    fs.writeFileSync(`${tmp}/src/x.txt`, 'data');
    const r = await runCp({ src: `${tmp}/src`, dst: `${tmp}/dst`, recursive: true });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(`${tmp}/dst/x.txt`, 'utf-8')).toBe('data');
  });

  it('rejects empty src', async () => {
    const r = await runCp({ src: '', dst: '/x' });
    expect(r.ok).toBe(false);
  });
});