/**
 * grep — 在文件中搜索文本 (ripgrep 包装)
 *
 * Borrowed from OpenCode `tool/grep.ts` (rg subprocess wrapper).
 * Hardened with H12: streaming byte counter + MAX_GREP_OUTPUT_BYTES kill.
 */

import { spawn } from 'node:child_process';
import type { ToolDefinition } from '../../registry.js';
import { grepSchema, grepJsonSchema } from '../../_schemas.js';

import { TOOL_LIMITS, TIMEOUTS } from '../../../config/constants.js';

const MAX_GREP_OUTPUT_BYTES = TOOL_LIMITS.GREP_MAX_OUTPUT_BYTES;
const DEFAULT_GREP_TIMEOUT_MS = TIMEOUTS.GREP_DEFAULT_MS;

export async function runGrep(args: Record<string, unknown>) {
  // H19: zod 验证 (timeoutMs 也进 schema)
  const parsed = grepSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { pattern, path, include, timeoutMs } = parsed.data;
  const pathFinal = path ?? '.';
  const timeoutFinal = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : DEFAULT_GREP_TIMEOUT_MS;

  const flags = ['--line-number', '--no-heading'];
  if (include) flags.push(`--glob=${include}`);

  return new Promise((resolve) => {
    const p = spawn('rg', [...flags, pattern, pathFinal], { windowsHide: true });
    let out = '';
    let err = '';
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;
    let killReason: 'output' | 'timeout' | null = null;

    const timeoutHandle = setTimeout(() => {
      if (killed) return;
      killed = true;
      killReason = 'timeout';
      p.kill();
    }, timeoutFinal);

    p.stdout.on('data', d => {
      if (killed) return;
      outBytes += d.length;
      if (outBytes > MAX_GREP_OUTPUT_BYTES) {
        killed = true;
        killReason = 'output';
        p.kill();
        return;
      }
      out += d.toString('utf-8');
    });
    p.stderr.on('data', d => {
      if (killed) return;
      errBytes += d.length;
      if (errBytes > MAX_GREP_OUTPUT_BYTES) {
        killed = true;
        killReason = 'output';
        p.kill();
        return;
      }
      err += d.toString('utf-8');
    });
    p.on('error', e => {
      clearTimeout(timeoutHandle);
      resolve({ ok: false, error: `rg spawn failed: ${String(e)}` });
    });
    p.on('close', code => {
      clearTimeout(timeoutHandle);
      if (killReason === 'output') {
        resolve({ ok: false, error: `output exceeds ${MAX_GREP_OUTPUT_BYTES} byte limit` });
        return;
      }
      if (killReason === 'timeout') {
        resolve({ ok: false, error: `rg timed out after ${timeoutFinal}ms` });
        return;
      }
      if (code === 0 || code === 1) {
        resolve({ ok: true, output: out.trim() || '(no matches)', exitCode: code });
      } else {
        resolve({ ok: false, error: `rg exit ${code}: ${err.trim()}` });
      }
    });
  });
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  displayName: '搜文本',
  displayDescription: '在文件中搜索文本 (ripgrep 包装)',
  description: 'Search file contents with ripgrep. Borrowed from OpenCode tool/grep.ts.',
  parameters: grepJsonSchema as Record<string, unknown>,
  risk: 'low',
  execute: runGrep,
};