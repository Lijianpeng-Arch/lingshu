/**
 * rm — 递归删除目录 (或 force 删除文件)
 *
 * Borrowed from OpenCode `tool/bash.ts` rm branch.
 */

import * as fs from 'node:fs';
import type { ToolDefinition } from '../../registry.js';
import { isInsideSandbox, sandboxViolationError } from '../../sandbox.js';
import { rmSchema, rmJsonSchema } from '../../_schemas.js';

export async function runRm(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = rmSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { path: target, force } = parsed.data;
  if (!isInsideSandbox(target)) return sandboxViolationError(target);
  const forceFinal = force === undefined ? false : force;

  try {
    fs.rmSync(target, { recursive: true, force: forceFinal });
    return { ok: true, output: `Removed ${target}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const rmTool: ToolDefinition = {
  name: 'rm',
  displayName: '删除目录',
  displayDescription: '递归删除目录 (含子目录和文件)',
  description: 'Recursively remove a directory (or force-delete a file). Borrowed from OpenCode tool/bash.ts.',
  parameters: rmJsonSchema as Record<string, unknown>,
  risk: 'high',
  execute: runRm,
};