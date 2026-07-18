import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runMkdir } from './mkdir.js';
import { setSandboxRoot } from '../../sandbox.js';

describe('mkdir', () => {
  let tmp: string;

  beforeEach(() => {
    setSandboxRoot(os.tmpdir());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-test-'));
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('creates a directory', async () => {
    const r = await runMkdir({ path: `${tmp}/new` });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(`${tmp}/new`)).toBe(true);
  });

  it('creates parent directories (recursive=true default)', async () => {
    const r = await runMkdir({ path: `${tmp}/a/b/c` });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(`${tmp}/a/b/c`)).toBe(true);
  });

  it('rejects empty path', async () => {
    const r = await runMkdir({ path: '' });
    expect(r.ok).toBe(false);
  });
});