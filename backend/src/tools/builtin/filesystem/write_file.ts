/**
 * write_file — 将内容写入文件, 自动创建父目录
 *
 * Borrowed from OpenCode `tool/write.ts` (full overwrite, mkdir -p).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '../../registry.js';
import { isInsideSandbox, sandboxViolationError } from '../../sandbox.js';
import { writeFileSchema, writeFileJsonSchema } from '../../_schemas.js';

export async function runWriteFile(args: Record<string, unknown>) {
  // H19: zod 替代手动 String() 转换 + undefined check
  const parsed = writeFileSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { path: target, content } = parsed.data;
  if (!isInsideSandbox(target)) return sandboxViolationError(target);

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return { ok: true, output: `Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${target}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  displayName: '写入文件',
  displayDescription: '将内容写入文件 (覆盖), 自动创建父目录',
  description: 'Write content to a file (overwrites), creates parent dirs as needed. Borrowed from OpenCode tool/write.ts.',
  parameters: writeFileJsonSchema as Record<string, unknown>,
  risk: 'medium',
  execute: runWriteFile,
};