/**
 * glob — 按 glob 模式查找文件
 *
 * Borrowed from OpenCode `tool/glob.ts` (fast-glob wrapper).
 */

import fg from 'fast-glob';
import type { ToolDefinition } from '../../registry.js';
import { globSchema, globJsonSchema } from '../../_schemas.js';

const MAX_GLOB_ENTRIES = 10_000;
const MAX_GLOB_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB

export async function runGlob(args: Record<string, unknown>) {
  // H19: zod 验证
  const parsed = globSchema.safeParse(args);
  if (!parsed.success) return { ok: false as const, error: `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}` };
  const { pattern, cwd, ignore } = parsed.data;
  const cwdFinal = cwd ?? process.cwd();
  const ignoreFinal = ignore ?? ['node_modules', '.git'];

  try {
    let files = await fg(pattern, { cwd: cwdFinal, ignore: ignoreFinal, onlyFiles: true });

    // M12: 截断条目数
    let truncatedNote = '';
    if (files.length > MAX_GLOB_ENTRIES) {
      files = files.slice(0, MAX_GLOB_ENTRIES);
      truncatedNote = `\n<NOTE>Output truncated: showing first ${MAX_GLOB_ENTRIES} entries of total match</NOTE>`;
    }

    let joined = files.join('\n');
    // M12: 字节上限
    if (joined.length > MAX_GLOB_OUTPUT_BYTES) {
      // 按字节切片 (String.prototype.length 在 BMP 内是 char 数,这里用于估算够用)
      joined = joined.slice(0, MAX_GLOB_OUTPUT_BYTES);
      joined += `\n<NOTE>Output truncated: exceeded ${MAX_GLOB_OUTPUT_BYTES} byte limit</NOTE>`;
    }

    const output = joined + truncatedNote;
    return { ok: true, output, count: files.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const globTool: ToolDefinition = {
  name: 'glob',
  displayName: '按名找文件',
  displayDescription: '用 glob 模式找文件 (如 "**/*.ts")',
  description: 'Find files matching a glob pattern. Borrowed from OpenCode tool/glob.ts.',
  parameters: globJsonSchema as Record<string, unknown>,
  risk: 'low',
  execute: runGlob,
};
