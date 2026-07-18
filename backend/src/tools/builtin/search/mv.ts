/**
 * mv — 移动文件或重命名
 *
 * Borrowed from OpenCode `tool/bash.ts` mv branch.
 */

import * as fs from 'node:fs';
import type { ToolDefinition } from '../../registry.js';
import { isInsideSandbox, sandboxViolationError } from '../../sandbox.js';
import { mvSchema, mvJsonSchema } from '../../_schemas.js';

export async function runMv(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = mvSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { src, dst } = parsed.data;
  if (!isInsideSandbox(src)) return sandboxViolationError(src);
  if (!isInsideSandbox(dst)) return sandboxViolationError(dst);

  try {
    fs.renameSync(src, dst);
    return { ok: true, output: `Moved ${src} → ${dst}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const mvTool: ToolDefinition = {
  name: 'mv',
  displayName: '移动/重命名',
  displayDescription: '移动文件或重命名',
  description: 'Move or rename a file/directory. Borrowed from OpenCode tool/bash.ts.',
  parameters: mvJsonSchema as Record<string, unknown>,
  risk: 'medium',
  execute: runMv,
};