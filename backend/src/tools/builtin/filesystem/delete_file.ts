/**
 * delete_file — 删除单个文件 (不删目录)
 *
 * Borrowed from OpenCode `tool/bash.ts` filesystem delete branch (refuse directories, use rm tool instead).
 */

import * as fs from 'node:fs';
import type { ToolDefinition } from '../../registry.js';
import { isInsideSandbox, sandboxViolationError } from '../../sandbox.js';
import { deleteFileSchema, deleteFileJsonSchema } from '../../_schemas.js';

export async function runDeleteFile(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = deleteFileSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { path: target } = parsed.data;
  if (!isInsideSandbox(target)) return sandboxViolationError(target);

  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return { ok: false, error: `Use rm tool for directories: ${target}` };
    fs.unlinkSync(target);
    return { ok: true, output: `Deleted ${target}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  displayName: '删除文件',
  displayDescription: '删除单个文件 (不删目录)',
  description: 'Delete a single file; refuses directories (use rm tool). Borrowed from OpenCode tool/bash.ts.',
  parameters: deleteFileJsonSchema as Record<string, unknown>,
  risk: 'high',
  execute: runDeleteFile,
};