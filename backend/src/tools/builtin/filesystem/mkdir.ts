/**
 * mkdir — 创建目录 (默认 recursive, 自动创建父目录)
 *
 * Borrowed from OpenCode `tool/bash.ts` mkdir branch.
 */

import * as fs from 'node:fs';
import type { ToolDefinition } from '../../registry.js';
import { isInsideSandbox, sandboxViolationError } from '../../sandbox.js';
import { mkdirSchema, mkdirJsonSchema } from '../../_schemas.js';

export async function runMkdir(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = mkdirSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { path: target, recursive } = parsed.data;
  if (!isInsideSandbox(target)) return sandboxViolationError(target);
  const recursiveFinal = recursive === undefined ? true : recursive;

  try {
    fs.mkdirSync(target, { recursive: recursiveFinal });
    return { ok: true, output: `Created ${target}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const mkdirTool: ToolDefinition = {
  name: 'mkdir',
  displayName: '创建目录',
  displayDescription: '创建目录 (默认递归, 自动创建父目录)',
  description: 'Create a directory (mkdir -p semantics by default). Borrowed from OpenCode tool/bash.ts.',
  parameters: mkdirJsonSchema as Record<string, unknown>,
  risk: 'medium',
  execute: runMkdir,
};