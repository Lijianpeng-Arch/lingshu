import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runRm } from './rm.js';
import { setSandboxRoot } from '../../sandbox.js';

describe('rm', () => {
  let tmp: string;

  beforeEach(() => {
    setSandboxRoot(os.tmpdir());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-test-'));
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('removes a directory recursively', async () => {
    fs.mkdirSync(`${tmp}/sub/nested`, { recursive: true });
    fs.writeFileSync(`${tmp}/sub/x.txt`, 'y');
    const r = await runRm({ path: `${tmp}/sub` });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(`${tmp}/sub`)).toBe(false);
  });

  it('removes a single file', async () => {
    fs.writeFileSync(`${tmp}/a.txt`, 'x');
    const r = await runRm({ path: `${tmp}/a.txt` });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(`${tmp}/a.txt`)).toBe(false);
  });

  it('force=true ignores non-existent path', async () => {
    const r = await runRm({ path: `${tmp}/nope`, force: true });
    expect(r.ok).toBe(true);
  });

  it('rejects empty path', async () => {
    const r = await runRm({ path: '' });
    expect(r.ok).toBe(false);
  });
});