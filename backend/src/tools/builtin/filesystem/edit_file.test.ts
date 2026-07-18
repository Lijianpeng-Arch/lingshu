import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runEditFile } from './edit_file.js';
import { setSandboxRoot } from '../../sandbox.js';

describe('edit_file', () => {
  let tmp: string;
  let testFile: string;

  beforeEach(() => {
    setSandboxRoot(os.tmpdir());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-test-'));
    testFile = `${tmp}/foo.txt`;
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('replaces exact match', async () => {
    fs.writeFileSync(testFile, 'hello world');
    const r = await runEditFile({ path: testFile, oldText: 'world', newText: 'JS' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('hello JS');
  });

  it('rejects on no match (safety)', async () => {
    fs.writeFileSync(testFile, 'hello');
    const r = await runEditFile({ path: testFile, oldText: 'world', newText: 'JS' });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/not found/);
  });

  it('rejects on ambiguous match', async () => {
    fs.writeFileSync(testFile, 'foo foo');
    const r = await runEditFile({ path: testFile, oldText: 'foo', newText: 'bar' });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/matches 2 times/);
  });

  it('rejects files larger than 5 MB', async () => {
    fs.writeFileSync(testFile, 'x');
    fs.truncateSync(testFile, 5 * 1024 * 1024 + 1);

    const r = await runEditFile({ path: testFile, oldText: 'x', newText: 'y' });

    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/5 MB/i);
  });

  it('rejects empty oldText (safety)', async () => {
    fs.writeFileSync(testFile, 'x');
    const r = await runEditFile({ path: testFile, oldText: '', newText: 'y' });
    expect(r.ok).toBe(false);
  });
});