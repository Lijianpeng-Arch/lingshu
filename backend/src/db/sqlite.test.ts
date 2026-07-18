import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqlite } from './sqlite.js';

describe('createSqlite', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lingshu-sqlite-'));
    dbPath = join(dir, 'test.sqlite');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates a sqlite database', () => {
    const db = createSqlite(dbPath);
    expect(db).toBeDefined();
    db.close();
  });
  it('runs migrations on creation', () => {
    const db = createSqlite(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
    const names = tables.map(t => t.name);
    expect(names).toContain('providers');
    db.close();
  });
  it('is idempotent — calling createSqlite twice does not duplicate tables', () => {
    const db1 = createSqlite(dbPath); db1.close();
    const db2 = createSqlite(dbPath);
    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'").all();
    expect(tables).toHaveLength(1);
    db2.close();
  });
  it('v2 migration: memories/thoughts/tasks/reminders 4 表存在', () => {
    const db = createSqlite(dbPath);
    for (const table of ['memories', 'thoughts', 'tasks', 'reminders']) {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      expect(row).toBeDefined();
    }
    db.close();
  });
});
