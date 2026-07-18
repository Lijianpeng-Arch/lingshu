import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runGitStatus } from './git_status.js';

const HAS_GIT = spawnSync('git', ['--version']).status === 0;

describe('git_status', () => {
  let tmp: string;

  beforeEach(() => {
    if (!HAS_GIT) return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-git-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    fs.writeFileSync(`${tmp}/a.txt`, 'hello');
    spawnSync('git', ['add', '.'], { cwd: tmp });
    spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmp });
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it.runIf(HAS_GIT)('reports clean when no changes', async () => {
    const r = await runGitStatus({ cwd: tmp });
    expect(r.ok).toBe(true);
    expect((r as any).output).toBe('(clean)');
  });

  it.runIf(HAS_GIT)('lists untracked files', async () => {
    fs.writeFileSync(`${tmp}/new.txt`, 'x');
    const r = await runGitStatus({ cwd: tmp });
    expect(r.ok).toBe(true);
    expect((r as any).output).toContain('new.txt');
  });

  it.runIf(HAS_GIT)('returns error for non-repo dir', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-plain-'));
    try {
      const r = await runGitStatus({ cwd: plain });
      expect(r.ok).toBe(false);
    } finally {
      try { fs.rmSync(plain, { recursive: true, force: true }); } catch {}
    }
  });
});