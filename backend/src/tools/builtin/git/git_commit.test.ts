import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runGitCommit } from './git_status.js';

const HAS_GIT = spawnSync('git', ['--version']).status === 0;

describe('git_commit', () => {
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

  it.runIf(HAS_GIT)('commits a new file', async () => {
    fs.writeFileSync(`${tmp}/b.txt`, 'new');
    const r = await runGitCommit({ cwd: tmp, message: 'add b.txt' });
    expect(r.ok).toBe(true);
    // verify commit happened
    const log = spawnSync('git', ['log', '--oneline'], { cwd: tmp, encoding: 'utf-8' });
    expect(log.stdout).toContain('add b.txt');
  });

  it.runIf(HAS_GIT)('refuses message containing "push" (hardcoded)', async () => {
    fs.writeFileSync(`${tmp}/c.txt`, 'new');
    const r = await runGitCommit({ cwd: tmp, message: 'push this fix' });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/forbids push/);
  });

  it.runIf(HAS_GIT)('refuses empty message', async () => {
    fs.writeFileSync(`${tmp}/d.txt`, 'new');
    const r = await runGitCommit({ cwd: tmp, message: '' });
    expect(r.ok).toBe(false);
  });

  it.runIf(HAS_GIT)('adds only specified files', async () => {
    fs.writeFileSync(`${tmp}/e1.txt`, '1');
    fs.writeFileSync(`${tmp}/e2.txt`, '2');
    const r = await runGitCommit({ cwd: tmp, message: 'add only e1', files: ['e1.txt'] });
    expect(r.ok).toBe(true);
    const status = spawnSync('git', ['status', '--short'], { cwd: tmp, encoding: 'utf-8' });
    expect(status.stdout).toContain('e2.txt'); // e2 still untracked, not committed
  });
});