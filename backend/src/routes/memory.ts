/**
 * MVP /api/memory — 长期记忆路由 (Phase 4 简化版)
 *
 * 端点:
 * - POST /api/memory/recall  { recentMessages: string[] } → { facts: string[] }
 * - POST /api/memory/store   { fact: string } → { ok: boolean }
 *
 * 简化: LIKE 匹配,生产版用向量数据库。
 * 数据: server buildApp 传 db 连接 (测试用 :memory:,生产用 ~/.lingshu/data.sqlite)
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createSqlite } from '../db/sqlite.js';
import { hashCode } from '../util/id.js';
import * as path from 'node:path';
import * as os from 'node:os';

interface RecallRequest {
  sessionId?: string;
  recentMessages?: string[];
}

interface MemoryRouteOptions {
  /** 显式传 db 连接; 不传则从 LINGSHU_DB_PATH 创建 (生产用) */
  db?: Database.Database;
}

function defaultDbPath(): string {
  return (
    process.env.LINGSHU_DB_PATH ??
    process.env['LINGSHU_DB_PATH'] ??
    path.join(os.homedir(), '.lingshu', 'data.sqlite')
  );
}

let _db: Database.Database | null = null;
function getDb(optsDb?: Database.Database): Database.Database {
  if (optsDb) return optsDb;
  if (!_db) _db = createSqlite(defaultDbPath());
  return _db;
}

export async function memoryRoutes(app: FastifyInstance, opts: MemoryRouteOptions = {}) {
  const sql = getDb(opts.db);

  app.post('/api/memory/recall', async (req) => {
    const body = (req.body ?? {}) as RecallRequest;
    const messages = Array.isArray(body.recentMessages) ? body.recentMessages : [];
    if (messages.length === 0) return { facts: [] };

    const recent = messages.slice(-3).join(' ').slice(0, 500);
    // 提取关键词: 英文词 (2+) + 中文单字 + 常见 2 字词
    const keywords = new Set<string>();
    for (const m of recent.match(/[a-zA-Z]{2,}/g) ?? []) keywords.add(m);
    // 中文: 用 1-2 字 sliding window
    const chinese = recent.match(/[一-龥]+/g) ?? [];
    for (const seg of chinese) {
      for (let i = 0; i < seg.length; i++) {
        keywords.add(seg[i]);
        if (i + 1 < seg.length) keywords.add(seg[i] + seg[i + 1]);
      }
    }
    const kwArr = Array.from(keywords).slice(0, 15);

    const facts = new Set<string>();
    try {
      // 合并 15 次 LIKE 为单次 OR 查询, 减少 prepare + 15 round-trip 开销
      // value 列有索引 (idx_memory_value), 大表下也能秒回
      if (kwArr.length > 0) {
        const placeholders = kwArr.map(() => 'value LIKE ?').join(' OR ');
        const params = kwArr.map((kw) => `%${kw}%`);
        const rows = sql
          .prepare(
            `SELECT value FROM long_term_memory WHERE ${placeholders} ORDER BY updated_at DESC LIMIT 50`,
          )
          .all(...params) as Array<{ value: string }>;
        for (const r of rows) {
          if (r.value) facts.add(r.value);
          if (facts.size >= 5) break;
        }
      }
    } catch {
      return { facts: [] };
    }
    return { facts: Array.from(facts).slice(0, 5) };
  });

  app.post('/api/memory/store', async (req) => {
    const body = (req.body ?? {}) as { fact?: string };
    if (!body.fact) return { ok: false, error: 'fact 必填' };
    try {
      const now = Date.now();
      const key = `mvp-${Math.abs(hashCode(body.fact))}`;
      sql.prepare(
        `INSERT OR REPLACE INTO long_term_memory (key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(key, body.fact, now, now);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
}