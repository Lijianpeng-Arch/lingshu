import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runGitDiff } from './git_status.js';

const HAS_GIT = spawnSync('git', ['--version']).status === 0;

describe('git_diff', () => {
  let tmp: string;

  beforeEach(() => {
    if (!HAS_GIT) return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-git-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    fs.writeFileSync(`${tmp}/a.txt`, 'line1\nline2\nline3\n');
    spawnSync('git', ['add', '.'], { cwd: tmp });
    spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmp });
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it.runIf(HAS_GIT)('shows unstaged diff after modify', async () => {
    fs.writeFileSync(`${tmp}/a.txt`, 'line1-changed\nline2\nline3\n');
    const r = await runGitDiff({ cwd: tmp, staged: false });
    expect(r.ok).toBe(true);
    expect((r as any).output).toContain('line1-changed');
  });

  it.runIf(HAS_GIT)('shows staged diff after add', async () => {
    fs.writeFileSync(`${tmp}/a.txt`, 'line1-changed\nline2\nline3\n');
    spawnSync('git', ['add', '.'], { cwd: tmp });
    const r = await runGitDiff({ cwd: tmp, staged: true });
    expect(r.ok).toBe(true);
    expect((r as any).output).toContain('line1-changed');
  });

  it.runIf(HAS_GIT)('returns (no diff) when clean', async () => {
    const r = await runGitDiff({ cwd: tmp });
    expect(r.ok).toBe(true);
    expect((r as any).output).toBe('(no diff)');
  });
});