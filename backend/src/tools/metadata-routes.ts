/**
 * Tool metadata HTTP routes
 *
 * Spec 2B — 暴露 16 个内置工具的元数据给前端 / 任何消费方。
 *
 * - GET /api/tools       → 完整 metadata.json
 * - GET /api/tools/:name → 完整 ToolDefinition (含 parameters schema)
 *
 * 文件读自 `backend/src/tools/metadata.json` (相对本文件路径)。该 JSON 在
 * build/boot 时由 `scripts/generate-tool-metadata.ts` 自动生成,不要手维护。
 */

import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { BUILTIN_TOOLS } from './builtin.js';

export interface ToolMetadataRouteOpts {
  /**
   * metadata.json 的绝对路径。默认相对本文件路径找
   * `backend/src/tools/metadata.json`。
   * 注入方便测试。
   */
  metadataPath?: string;
  /**
   * builtin.ts 工具列表。注入方便测试。
   * 默认从 `./builtin.js` 导出的 BUILTIN_TOOLS 取。
   */
  tools?: typeof BUILTIN_TOOLS;
}

function resolveDefaultMetadataPath(): string {
  // 本文件位于 backend/src/tools/metadata-routes.ts
  // metadata.json 位于 backend/src/tools/metadata.json (同级)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, 'metadata.json');
}

export function createToolMetadataRoutes(opts: ToolMetadataRouteOpts = {}) {
  const tools = opts.tools ?? BUILTIN_TOOLS;
  const metadataPath = opts.metadataPath ?? resolveDefaultMetadataPath();

  function readMetadata(): unknown {
    if (!existsSync(metadataPath)) {
      throw new Error(`metadata.json not found at ${metadataPath}. Run \`npm run gen:metadata\`.`);
    }
    const raw = readFileSync(metadataPath, 'utf-8');
    return JSON.parse(raw) as unknown;
  }

  function serializeTool(tool: typeof BUILTIN_TOOLS[number]): Record<string, unknown> {
    // 与 BUILTIN_TOOLS 一一对应: 去掉 execute (runtime fn, 不可 JSON 序列化)
    return {
      name: tool.name,
      displayName: tool.displayName,
      displayDescription: tool.displayDescription,
      description: tool.description,
      parameters: tool.parameters,
      risk: tool.risk,
    };
  }

  return async function toolMetadataRoutes(app: FastifyInstance): Promise<void> {
    app.get('/api/tools', async () => {
      return readMetadata();
    });

    app.get<{ Params: { name: string } }>('/api/tools/:name', async (req, reply) => {
      const name = req.params.name;
      const tool = tools.find(t => t.name === name);
      if (!tool) {
        reply.code(404);
        return { ok: false, error: `tool "${name}" not found`, available: tools.map(t => t.name) };
      }
      return { ok: true, tool: serializeTool(tool) };
    });
  };
}
