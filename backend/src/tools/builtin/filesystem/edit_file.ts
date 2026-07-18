/**
 * edit_file — 精确匹配替换一段文本 (防误改: 必须唯一匹配才成功)
 *
 * Borrowed from OpenCode `tool/edit.ts` (uniqueness-checked string replace).
 */

import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import type { ToolDefinition } from '../../registry.js';
import { isInsideSandbox, sandboxViolationError } from '../../sandbox.js';
import { editFileSchema, editFileJsonSchema } from '../../_schemas.js';
import { TOOL_LIMITS } from '../../../config/constants.js';

const EDIT_MAX_BYTES = TOOL_LIMITS.EDIT_MAX_BYTES;

export async function runEditFile(args: Record<string, unknown>) {
  const parsed = editFileSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { path: target, oldText, newText } = parsed.data;
  if (!oldText) return { ok: false, error: 'oldText is required (refusing empty match for safety)' };
  if (!isInsideSandbox(target)) return sandboxViolationError(target);

  try {
    const stat = await fsp.stat(target);
    if (stat.size > EDIT_MAX_BYTES) {
      return { ok: false as const, error: `File exceeds 5 MB (${stat.size} bytes); edit_file refuses to load oversized files` };
    }
    const content = await fsp.readFile(target, 'utf-8');
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) return { ok: false as const, error: `oldText not found in ${target}` };
    if (occurrences > 1) return { ok: false as const, error: `oldText matches ${occurrences} times (must be unique)` };
    await fsp.writeFile(target, content.replace(oldText, newText), 'utf-8');
    return { ok: true as const, output: `Edited ${target}` };
  } catch (err) {
    return { ok: false as const, error: String(err) };
  }
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  displayName: '编辑文件',
  displayDescription: '精确匹配替换一段文本 (防误改: 唯一匹配才成功)',
  description: 'Exact-match string replace; refuses to operate when oldText appears 0 or >1 times. Borrowed from OpenCode tool/edit.ts.',
  parameters: editFileJsonSchema as Record<string, unknown>,
  risk: 'medium',
  execute: runEditFile,
};