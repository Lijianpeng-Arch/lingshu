import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createSqlite } from '../db/sqlite.js';
import { createMemoryRepo } from './repo.js';
import { idleMemoryConsolidation } from './idle.js';

describe('idleMemoryConsolidation', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let repo: ReturnType<typeof createMemoryRepo>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lingshu-idle-'));
    dbPath = join(dir, 'test.sqlite');
    db = createSqlite(dbPath);
    repo = createMemoryRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. 两条内容相似的 short → 合并 (merged=1)
  it('merges near-duplicate short memories (first 50 chars)', async () => {
    // both contents share the same 50-char prefix (first 60 chars are identical)
    const prefix = 'a'.repeat(60);
    repo.memories.put({ scope: 'short', content: prefix, tags: [], importance: 0.5 });
    repo.memories.put({ scope: 'short', content: prefix + ' + extra', tags: [], importance: 0.5 });

    const result = await idleMemoryConsolidation(repo.memories);
    expect(result.merged).toBe(1);
    expect(repo.memories.list('short')).toHaveLength(1);
  });

  // 2. importance<0.3 + 30 天未访问 → 删 (pruned=1)
  it('prunes short memories with importance<0.3 and untouched >30 days', async () => {
    // Use raw SQL to bypass repo's Date.now() default
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO memories
      (id, scope, key, content, tags, importance, access_count, last_accessed_at, created_at, updated_at)
      VALUES (?, 'short', NULL, 'stale', '[]', 0.1, 0, ?, ?, ?)`).run('stale-1', oldTime, oldTime, oldTime);
    db.prepare(`INSERT INTO memories
      (id, scope, key, content, tags, importance, access_count, last_accessed_at, created_at, updated_at)
      VALUES (?, 'short', NULL, 'fresh', '[]', 0.1, 0, ?, ?, ?)`).run('fresh-low', Date.now(), Date.now(), Date.now());

    const result = await idleMemoryConsolidation(repo.memories);
    expect(result.pruned).toBe(1);
    expect(repo.memories.get('stale-1')).toBeUndefined();
    expect(repo.memories.get('fresh-low')).toBeDefined();
  });

  // 3. accessCount>=5 的 short → 升级 long (promoted=1)
  it('promotes short memories with accessCount >= 5 to scope=long', async () => {
    const stored = repo.memories.put({ scope: 'short', content: 'hot path', tags: [], importance: 0.8 });
    // bump access_count to threshold via direct SQL
    db.prepare(`UPDATE memories SET access_count = 6 WHERE id = ?`).run(stored.id);

    const result = await idleMemoryConsolidation(repo.memories);
    expect(result.promoted).toBe(1);
    const promoted = repo.memories.get(stored.id);
    expect(promoted?.scope).toBe('long');
  });

  // 4. 返回值结构正确
  it('returns result with merged/pruned/promoted numeric fields', async () => {
    repo.memories.put({ scope: 'short', content: 'one', tags: [], importance: 0.5 });
    repo.memories.put({ scope: 'short', content: 'two', tags: [], importance: 0.5 });

    const result = await idleMemoryConsolidation(repo.memories);
    expect(typeof result.merged).toBe('number');
    expect(typeof result.pruned).toBe('number');
    expect(typeof result.promoted).toBe('number');
    expect(result.merged).toBe(0);
    expect(result.pruned).toBe(0);
    expect(result.promoted).toBe(0);
  });

  // 5. 空 repo 返回全 0
  it('returns all zeros on an empty repo', async () => {
    const result = await idleMemoryConsolidation(repo.memories);
    expect(result).toEqual({ merged: 0, pruned: 0, promoted: 0 });
  });
});