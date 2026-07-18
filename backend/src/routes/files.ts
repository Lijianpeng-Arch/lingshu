/**
 * MVP /api/files — 文件工具路由 (Phase 2)
 *
 * 4 个端点:
 * - POST /api/files/list   { path: string }
 * - POST /api/files/read   { path: string, encoding?: 'utf-8' | 'base64' }
 * - POST /api/files/write  { path: string, content: string, confirmToken: string }
 * - POST /api/files/search { path: string, query: string, maxResults?: number }
 *
 * 沙盒守卫 (MVP 简化版):
 * - 默认 sandbox 根 = ~/.lingshu/sandbox
 * - 所有 path 必须 resolve 后在 sandbox 根内,否则 403
 * - 写操作必须 confirmToken === "approved" (前端弹窗用户点确认后传)
 * - 第一次启动自动建 sandbox 目录
 */

import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SANDBOX_ROOT = path.join(os.homedir(), '.lingshu', 'sandbox');

interface FilesRequest {
  path?: string;
  encoding?: 'utf-8' | 'base64';
  content?: string;
  query?: string;
  maxResults?: number;
  confirmToken?: string;
}

/** 解析 + 验证路径在 sandbox 内. 越界 throw. */
async function resolveSafePath(relPath: string): Promise<string> {
  const cleaned = (relPath ?? '').trim();
  if (!cleaned) throw new Error('path 不能为空');
  // 拒绝绝对路径 + 父目录引用
  if (path.isAbsolute(cleaned)) {
    throw new Error('path 必须是相对路径');
  }
  const resolved = path.resolve(SANDBOX_ROOT, cleaned);
  const normSandbox = path.resolve(SANDBOX_ROOT);
  if (!resolved.startsWith(normSandbox + path.sep) && resolved !== normSandbox) {
    throw new Error(`path 越界: ${cleaned}`);
  }
  return resolved;
}

async function ensureSandbox(): Promise<void> {
  try {
    await fs.mkdir(SANDBOX_ROOT, { recursive: true });
  } catch {
    // ignore
  }
}

export async function filesRoutes(app: FastifyInstance) {
  // 启动时确保 sandbox 存在
  await ensureSandbox();
  app.log.info(`[boot] MVP /api/files sandbox: ${SANDBOX_ROOT}`);

  // ── list ──
  app.post('/api/files/list', async (req, reply) => {
    const body = (req.body ?? {}) as FilesRequest;
    try {
      const target = await resolveSafePath(body.path ?? '.');
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        reply.code(400);
        return { error: 'path 不是目录' };
      }
      const entries = await fs.readdir(target, { withFileTypes: true });
      const out: Array<{ name: string; type: string; size: number | null }> = [];
      for (const e of entries) {
        const isDir = e.isDirectory();
        const isFile = e.isFile();
        let size: number | null = null;
        if (isFile) {
          try {
            size = (await fs.stat(path.join(target, e.name))).size;
          } catch {
            size = null;
          }
        }
        out.push({
          name: e.name,
          type: isDir ? 'dir' : isFile ? 'file' : 'other',
          size,
        });
      }
      return {
        path: path.relative(SANDBOX_ROOT, target) || '.',
        entries: out,
      };
    } catch (e: unknown) {
      const err = e as Error;
      reply.code(400);
      return { error: err.message };
    }
  });

  // ── read ──
  app.post('/api/files/read', async (req, reply) => {
    const body = (req.body ?? {}) as FilesRequest;
    try {
      const target = await resolveSafePath(body.path ?? '');
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        reply.code(400);
        return { error: 'path 不是文件' };
      }
      const encoding = body.encoding ?? 'utf-8';
      if (encoding === 'base64') {
        const buf = await fs.readFile(target);
        return { path: body.path, content: buf.toString('base64'), encoding: 'base64' };
      }
      const content = await fs.readFile(target, 'utf-8');
      return { path: body.path, content, encoding: 'utf-8' };
    } catch (e: unknown) {
      const err = e as Error;
      reply.code(400);
      return { error: err.message };
    }
  });

  // ── write (要 confirmToken) ──
  app.post('/api/files/write', async (req, reply) => {
    const body = (req.body ?? {}) as FilesRequest;
    if (body.confirmToken !== 'approved') {
      reply.code(403);
      return { error: '写文件需要用户确认 (confirmToken="approved")' };
    }
    if (typeof body.content !== 'string') {
      reply.code(400);
      return { error: 'content 必须是字符串' };
    }
    try {
      const target = await resolveSafePath(body.path ?? '');
      // 确保父目录存在
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body.content, 'utf-8');
      return { ok: true, path: body.path, bytes: Buffer.byteLength(body.content, 'utf-8') };
    } catch (e: unknown) {
      const err = e as Error;
      reply.code(400);
      return { error: err.message };
    }
  });

  // ── search (递归 grep) ──
  app.post('/api/files/search', async (req, reply) => {
    const body = (req.body ?? {}) as FilesRequest;
    const query = (body.query ?? '').trim();
    if (!query) {
      reply.code(400);
      return { error: 'query 不能为空' };
    }
    const max = Math.min(body.maxResults ?? 50, 200);
    const results: Array<{ path: string; line: number; text: string }> = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 6) return;
      if (results.length >= max) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= max) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          await walk(full, depth + 1);
        } else if (e.isFile() && (e.name.endsWith('.txt') || e.name.endsWith('.md'))) {
          // 简化: 只搜 .txt 和 .md (避免大文件)
          try {
            const content = await fs.readFile(full, 'utf-8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length && results.length < max; i++) {
              if (lines[i].includes(query)) {
                results.push({
                  path: path.relative(SANDBOX_ROOT, full),
                  line: i + 1,
                  text: lines[i].slice(0, 200),
                });
              }
            }
          } catch {
            // skip
          }
        }
      }
    }

    try {
      const target = await resolveSafePath(body.path ?? '.');
      await walk(target, 0);
      return { query, count: results.length, results };
    } catch (e: unknown) {
      const err = e as Error;
      reply.code(400);
      return { error: err.message };
    }
  });

  // ── sandbox meta ──
  app.get('/api/files/sandbox', async () => {
    return { root: SANDBOX_ROOT };
  });
}