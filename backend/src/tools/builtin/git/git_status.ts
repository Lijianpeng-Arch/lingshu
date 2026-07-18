/**
 * git_status / git_diff / git_commit — 三个 git 操作的工具封装
 *
 * Borrowed from OpenCode `tool/bash.ts` git branches.
 *
 * SAFETY:
 * - git_commit 硬编码禁 push (双保险, 即便用户规则 allow 也拒绝 message 中含 'push')
 * - 所有命令用 spawn (no shell), 避免命令注入
 * - M13: stdout/stderr 字节上限 + 30s 超时, 防止恶意仓库卡死工具
 */

import { spawn } from 'node:child_process';
import type { ToolDefinition } from '../../registry.js';
import {
  gitStatusSchema, gitDiffSchema, gitCommitSchema,
  gitStatusJsonSchema, gitDiffJsonSchema, gitCommitJsonSchema,
} from '../../_schemas.js';

const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB
const GIT_TIMEOUT_MS = 30_000; // 30s

function gitSpawn(args: string[], cwd = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedForSize = false;

    // 30s 超时
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
        if (!killedForSize) {
          killedForSize = true;
          try { proc.kill(); } catch {}
        }
        return;
      }
      out += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
        if (!killedForSize) {
          killedForSize = true;
          try { proc.kill(); } catch {}
        }
        return;
      }
      err += chunk.toString('utf-8');
    });
    proc.on('error', e => { clearTimeout(timer); reject(new Error(`git spawn failed: ${String(e)}`)); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (killedForSize) {
        reject(new Error(`git ${args[0]} output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes; killed`));
        return;
      }
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args[0]} exit ${code}: ${err.trim()}`));
    });
  });
}

// ===== git_status =====

export async function runGitStatus(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = gitStatusSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { cwd } = parsed.data;
  const cwdFinal = cwd ?? process.cwd();
  try {
    const out = await gitSpawn(['status', '--short'], cwdFinal);
    return { ok: true, output: out.trim() || '(clean)' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  displayName: 'git 状态',
  displayDescription: '显示 git working tree 状态',
  description: 'Show short git status. Borrowed from OpenCode tool/bash.ts.',
  parameters: gitStatusJsonSchema as Record<string, unknown>,
  risk: 'low',
  execute: runGitStatus,
};

// ===== git_diff =====

export async function runGitDiff(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = gitDiffSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { cwd, staged } = parsed.data;
  const cwdFinal = cwd ?? process.cwd();
  const stagedFinal = staged === undefined ? false : staged;
  try {
    const flags = ['diff', stagedFinal ? '--staged' : ''].filter(Boolean);
    const out = await gitSpawn(flags, cwdFinal);
    return { ok: true, output: out.trim() || '(no diff)' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  displayName: 'git diff',
  displayDescription: '显示未提交改动',
  description: 'Show git diff (unstaged by default). Borrowed from OpenCode tool/bash.ts.',
  parameters: gitDiffJsonSchema as Record<string, unknown>,
  risk: 'low',
  execute: runGitDiff,
};

// ===== git_commit =====

export async function runGitCommit(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = gitCommitSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { cwd, message, files } = parsed.data;
  const cwdFinal = cwd ?? process.cwd();
  if (!message.trim()) return { ok: false, error: 'commit message is required' };

  // 硬编码禁 push (双保险, 即便用户规则 allow 也拒绝)
  if (message.toLowerCase().includes('push')) {
    return { ok: false, error: 'git_commit tool forbids push. Run git push manually if you want to push.' };
  }

  const filesFinal = files ?? ['.'];

  try {
    await gitSpawn(['add', ...filesFinal], cwdFinal);
    const out = await gitSpawn(['commit', '-m', message], cwdFinal);
    return { ok: true, output: out.trim() || '(committed)' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  displayName: 'git 提交',
  displayDescription: 'git add + commit (绝不 push)',
  description: 'git add + commit; hardcoded rejects any message containing "push". Borrowed from OpenCode tool/bash.ts.',
  parameters: gitCommitJsonSchema as Record<string, unknown>,
  risk: 'high',
  execute: runGitCommit,
};
