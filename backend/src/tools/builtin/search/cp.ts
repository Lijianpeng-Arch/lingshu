/**
 * cp — 复制文件或目录
 *
 * Borrowed from OpenCode `tool/bash.ts` cp branch.
 */

import * as fs from 'node:fs';
import type { ToolDefinition } from '../../registry.js';
import { isInsideSandbox, sandboxViolationError } from '../../sandbox.js';
import { cpSchema, cpJsonSchema } from '../../_schemas.js';

export async function runCp(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = cpSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { src, dst, recursive } = parsed.data;
  if (!isInsideSandbox(src)) return sandboxViolationError(src);
  if (!isInsideSandbox(dst)) return sandboxViolationError(dst);
  const recursiveFinal = recursive === undefined ? false : recursive;

  try {
    fs.cpSync(src, dst, { recursive: recursiveFinal });
    return { ok: true, output: `Copied ${src} → ${dst}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const cpTool: ToolDefinition = {
  name: 'cp',
  displayName: '复制',
  displayDescription: '复制文件或目录',
  description: 'Copy a file or directory. Borrowed from OpenCode tool/bash.ts.',
  parameters: cpJsonSchema as Record<string, unknown>,
  risk: 'medium',
  execute: runCp,
};