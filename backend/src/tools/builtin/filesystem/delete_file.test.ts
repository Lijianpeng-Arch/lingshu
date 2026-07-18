import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runDeleteFile } from './delete_file.js';
import { setSandboxRoot } from '../../sandbox.js';

describe('delete_file', () => {
  let tmp: string;

  beforeEach(() => {
    setSandboxRoot(os.tmpdir());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-test-'));
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('deletes an existing file', async () => {
    const file = `${tmp}/a.txt`;
    fs.writeFileSync(file, 'x');
    const r = await runDeleteFile({ path: file });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to delete a directory', async () => {
    const dir = `${tmp}/sub`;
    fs.mkdirSync(dir);
    const r = await runDeleteFile({ path: dir });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/rm tool/);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('returns error for non-existent file', async () => {
    const r = await runDeleteFile({ path: `${tmp}/nonexistent.txt` });
    expect(r.ok).toBe(false);
  });

  it('rejects empty path', async () => {
    const r = await runDeleteFile({ path: '' });
    expect(r.ok).toBe(false);
  });
});