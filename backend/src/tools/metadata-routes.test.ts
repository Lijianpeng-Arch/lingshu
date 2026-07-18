/**
 * Tool metadata HTTP routes tests (Spec 2B)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createToolMetadataRoutes } from './metadata-routes.js';
import { BUILTIN_TOOLS } from './builtin.js';

let app: ReturnType<typeof Fastify>;
let tmpDir: string;
let metadataPath: string;

const SAMPLE_METADATA = {
  version: '2.0.0',
  generated: new Date().toISOString(),
  source: 'backend/src/tools/builtin.ts',
  description: 'test',
  tools: [
    { name: 'write_file', displayName: '写入文件', displayDescription: '写文件', category: 'filesystem', risk: 'medium' },
    { name: 'read_file', displayName: '读文件', displayDescription: '读文件', category: 'filesystem', risk: 'low' },
  ],
};

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'lingshu-toolmeta-'));
  metadataPath = path.join(tmpDir, 'metadata.json');
  writeFileSync(metadataPath, JSON.stringify(SAMPLE_METADATA, null, 2), 'utf-8');
  app = Fastify();
  await app.register(createToolMetadataRoutes({ metadataPath }));
});

afterEach(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/tools', () => {
  it('returns the metadata.json content', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe('2.0.0');
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0].name).toBe('write_file');
  });

  it('returns 500-shaped error body when metadata file is missing', async () => {
    rmSync(metadataPath);
    const res = await app.inject({ method: 'GET', url: '/api/tools' });
    // Fastify will surface the thrown error as 500
    expect(res.statusCode).toBe(500);
  });
});

describe('GET /api/tools/:name', () => {
  it('returns the full ToolDefinition for an existing tool', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tools/write_file' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.tool.name).toBe('write_file');
    expect(body.tool.displayName).toBe('写入文件');
    expect(body.tool.risk).toBe('medium');
    expect(body.tool.parameters).toBeDefined();
    expect(body.tool.parameters.type).toBe('object');
    // execute 不可序列化 → 不应在响应中
    expect(body.tool.execute).toBeUndefined();
  });

  it('returns 404 with available list for unknown tool', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tools/does_not_exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('does_not_exist');
    expect(Array.isArray(body.available)).toBe(true);
    expect(body.available).toContain('write_file');
    expect(body.available.length).toBe(BUILTIN_TOOLS.length);
  });

  it('returns all 16 builtin tools when each is queried by name', async () => {
    // Sanity: 16 个 builtin 全部可达
    for (const t of BUILTIN_TOOLS) {
      const res = await app.inject({ method: 'GET', url: `/api/tools/${t.name}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tool.name).toBe(t.name);
      expect(body.tool.displayName).toBe(t.displayName);
    }
  });
});
