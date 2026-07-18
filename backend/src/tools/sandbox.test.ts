/**
 * Sandbox guard tests — verify filesystem tools refuse to touch paths
 * outside the sandbox (C1 review fix).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { isInsideSandbox, setSandboxRoot, sandboxViolationError } from './sandbox.js';
import { runWriteFile } from './builtin/filesystem/write_file.js';
import { runEditFile } from './builtin/filesystem/edit_file.js';
import { runDeleteFile } from './builtin/filesystem/delete_file.js';
import { runMkdir } from './builtin/filesystem/mkdir.js';
import { runRm } from './builtin/search/rm.js';
import { runCp } from './builtin/search/cp.js';
import { runMv } from './builtin/search/mv.js';
import { runReadFile } from './builtin.js';

beforeAll(() => { setSandboxRoot(os.tmpdir()); });

describe('sandbox module', () => {
  it('isInsideSandbox accepts path equal to root', () => {
    expect(isInsideSandbox(os.tmpdir())).toBe(true);
  });
  it('isInsideSandbox accepts path inside root', () => {
    expect(isInsideSandbox(path.join(os.tmpdir(), 'sub'))).toBe(true);
  });
  it('isInsideSandbox rejects absolute path outside root', () => {
    if (process.platform === 'win32') {
      expect(isInsideSandbox('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(false);
    } else {
      expect(isInsideSandbox('/etc/hosts')).toBe(false);
    }
  });
  it('sandboxViolationError returns ok:false with descriptive message', () => {
    const r = sandboxViolationError('/etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside sandbox/i);
    expect(r.error).toContain('/etc/passwd');
  });
});

describe('filesystem tools refuse out-of-sandbox paths', () => {
  const outside = process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';

  it('write_file refuses', async () => {
    const r = await runWriteFile({ path: outside, content: 'x' });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('edit_file refuses', async () => {
    const r = await runEditFile({ path: outside, oldText: 'a', newText: 'b' });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('delete_file refuses', async () => {
    const r = await runDeleteFile({ path: outside });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('mkdir refuses', async () => {
    const r = await runMkdir({ path: outside });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('rm refuses', async () => {
    const r = await runRm({ path: outside });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('cp refuses src outside sandbox', async () => {
    const r = await runCp({ src: outside, dst: path.join(os.tmpdir(), 'dst') });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('cp refuses dst outside sandbox', async () => {
    const r = await runCp({ src: path.join(os.tmpdir(), 'src'), dst: outside });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('mv refuses src outside sandbox', async () => {
    const r = await runMv({ src: outside, dst: path.join(os.tmpdir(), 'dst') });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('mv refuses dst outside sandbox', async () => {
    const r = await runMv({ src: path.join(os.tmpdir(), 'src'), dst: outside });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
  it('read_file still refuses (preserved from prior guard)', async () => {
    const r = await runReadFile({ path: outside });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/outside sandbox/i);
  });
});