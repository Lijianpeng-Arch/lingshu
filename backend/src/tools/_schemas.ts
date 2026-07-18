/**
 * Tool parameter schemas — zod 化 13 个关键工具的 JSON Schema
 *
 * H19: 抽一次集中维护, 替代每个工具文件手写的 JSON Schema object。
 *
 * 设计:
 *   - 每个工具一个 zod schema
 *   - 同时导出 JSON Schema (供 metadata-routes 给前端展示)
 *   - hand-rolled 极简 converter (避免新增 zod-to-json-schema 依赖)
 *   - 只支持当前工具需要的 type:'object' + properties + required
 *
 * Borrowed from Hermes `tool_schemas.py` (集中 schema 管理模式)。
 */

import { z } from 'zod';

// ===== Filesystem =====

export const writeFileSchema = z.object({
  path: z.string().min(1).describe('文件绝对路径'),
  content: z.string().describe('要写入的内容'),
});

export const editFileSchema = z.object({
  path: z.string().min(1).describe('文件绝对路径'),
  oldText: z.string().describe('要替换的原文本'),
  newText: z.string().describe('新文本'),
});

export const deleteFileSchema = z.object({
  path: z.string().min(1).describe('文件绝对路径'),
});

export const mkdirSchema = z.object({
  path: z.string().min(1).describe('目录绝对路径'),
  recursive: z.boolean().optional().describe('递归创建父目录 (默认 true)'),
});

// ===== Search =====

export const mvSchema = z.object({
  src: z.string().min(1).describe('源路径'),
  dst: z.string().min(1).describe('目标路径'),
});

export const cpSchema = z.object({
  src: z.string().min(1).describe('源路径'),
  dst: z.string().min(1).describe('目标路径'),
  recursive: z.boolean().optional().describe('递归复制目录 (默认 false)'),
});

export const rmSchema = z.object({
  path: z.string().min(1).describe('路径'),
  force: z.boolean().optional().describe('强制 (忽略不存在) (默认 false)'),
});

export const globSchema = z.object({
  pattern: z.string().min(1).describe('glob 模式 (如 **/*.ts)'),
  cwd: z.string().optional().describe('搜索根目录 (默认 process.cwd())'),
  ignore: z.array(z.string()).optional().describe('要忽略的目录/模式'),
});

export const grepSchema = z.object({
  pattern: z.string().min(1).describe('正则或字面量模式'),
  path: z.string().optional().describe('搜索根路径 (默认 ".")'),
  include: z.string().optional().describe('文件 glob 过滤 (如 *.ts)'),
  timeoutMs: z.number().optional().describe('超时 (默认 30s,> 0 且 <= 300000)'),
});

// ===== Git =====

export const gitStatusSchema = z.object({
  cwd: z.string().optional().describe('仓库路径 (默认 process.cwd())'),
});

export const gitDiffSchema = z.object({
  cwd: z.string().optional().describe('仓库路径'),
  staged: z.boolean().optional().describe('查看已 staged 的改动 (默认 false)'),
});

export const gitCommitSchema = z.object({
  message: z.string().min(1).describe('commit message (不含 push)'),
  files: z.array(z.string()).optional().describe('要 add 的文件 (默认 ["."])'),
  cwd: z.string().optional().describe('仓库路径'),
});

// ===== JSON Schema converter (极简 hand-rolled) =====
// 只支持 object + properties + required + description
// 满足当前 13 个工具的形状; 未来需要更多类型时再扩。

type ZodField = {
  _def: {
    typeName: string;
    innerType?: { _def: { typeName: string } };
    description?: string;
  };
  description?: string;
  isOptional?: () => boolean;
};

function zodTypeToJson(field: ZodField): { type: string; description?: string } {
  // unwrap optional/nullable wrapper
  let inner: ZodField = field;
  while (
    inner._def.typeName === 'ZodOptional' ||
    inner._def.typeName === 'ZodNullable' ||
    inner._def.typeName === 'ZodDefault'
  ) {
    inner = inner._def.innerType as ZodField;
  }
  const t = inner._def.typeName;
  const desc = field.description ?? inner.description;
  switch (t) {
    case 'ZodString': return desc ? { type: 'string', description: desc } : { type: 'string' };
    case 'ZodNumber': return desc ? { type: 'number', description: desc } : { type: 'number' };
    case 'ZodBoolean': return desc ? { type: 'boolean', description: desc } : { type: 'boolean' };
    case 'ZodArray': {
      const innerArr = (inner._def as any).type;
      const items = innerArr ? zodTypeToJson(innerArr) : { type: 'string' };
      const arrSchema: any = { type: 'array', items };
      if (desc) arrSchema.description = desc;
      return arrSchema;
    }
    default: return desc ? { type: 'string', description: desc } : { type: 'string' };
  }
}

export function zodToJsonSchema(schema: z.ZodObject<any>): {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
} {
  const shape = (schema as any)._def.shape();
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const f = field as ZodField;
    properties[key] = zodTypeToJson(f);
    // ZodDefault / ZodOptional → not required
    const optional =
      f._def.typeName === 'ZodOptional' ||
      f._def.typeName === 'ZodNullable' ||
      f._def.typeName === 'ZodDefault';
    if (!optional) required.push(key);
  }
  const out: { type: 'object'; properties?: Record<string, unknown>; required?: string[] } = {
    type: 'object',
    properties,
  };
  if (required.length > 0) out.required = required;
  return out;
}

// 预生成 13 个 JSON Schema (供工具文件直接用)
export const writeFileJsonSchema = zodToJsonSchema(writeFileSchema);
export const editFileJsonSchema = zodToJsonSchema(editFileSchema);
export const deleteFileJsonSchema = zodToJsonSchema(deleteFileSchema);
export const mkdirJsonSchema = zodToJsonSchema(mkdirSchema);
export const mvJsonSchema = zodToJsonSchema(mvSchema);
export const cpJsonSchema = zodToJsonSchema(cpSchema);
export const rmJsonSchema = zodToJsonSchema(rmSchema);
export const globJsonSchema = zodToJsonSchema(globSchema);
export const grepJsonSchema = zodToJsonSchema(grepSchema);
export const gitStatusJsonSchema = zodToJsonSchema(gitStatusSchema);
export const gitDiffJsonSchema = zodToJsonSchema(gitDiffSchema);
export const gitCommitJsonSchema = zodToJsonSchema(gitCommitSchema);