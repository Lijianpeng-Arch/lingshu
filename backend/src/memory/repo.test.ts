import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createSqlite } from '../db/sqlite.js';
import { createMemoryRepo } from './repo.js';

describe('memory repos', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let repo: ReturnType<typeof createMemoryRepo>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lingshu-memrepo-'));
    dbPath = join(dir, 'test.sqlite');
    db = createSqlite(dbPath);
    repo = createMemoryRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. memories.put + get
  it('memories.put + get roundtrips a record', () => {
    const stored = repo.memories.put({ scope: 'short', content: 'hello', tags: ['a', 'b'], importance: 0.7 });
    expect(stored.id).toBeDefined();
    expect(stored.accessCount).toBe(0);

    const fetched = repo.memories.get(stored.id);
    expect(fetched?.content).toBe('hello');
    expect(fetched?.tags).toEqual(['a', 'b']);
    expect(fetched?.importance).toBe(0.7);
    expect(fetched?.scope).toBe('short');
  });

  // 2. memories.list(scope='short') 只返回 short
  it('memories.list(scope) filters by scope', () => {
    repo.memories.put({ scope: 'short', content: 'a', tags: [], importance: 0.5 });
    repo.memories.put({ scope: 'short', content: 'b', tags: [], importance: 0.5 });
    repo.memories.put({ scope: 'long', content: 'c', tags: [], importance: 0.9 });

    const shorts = repo.memories.list('short');
    expect(shorts).toHaveLength(2);
    expect(shorts.every(m => m.scope === 'short')).toBe(true);
  });

  // 3. memories.search LIKE 命中
  it('memories.search matches keyword across content and tags', () => {
    repo.memories.put({ scope: 'short', content: '用户喜欢咖啡', tags: ['user:preference'], importance: 0.6 });
    repo.memories.put({ scope: 'short', content: '天气晴朗', tags: ['weather'], importance: 0.3 });
    repo.memories.put({ scope: 'short', content: '今天喝了茶', tags: ['user:preference'], importance: 0.6 });

    const hits = repo.memories.search('咖啡');
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe('用户喜欢咖啡');

    const tagHits = repo.memories.search('user:preference');
    expect(tagHits.length).toBeGreaterThanOrEqual(2);
  });

  // 4. memories.touch 增加 accessCount + lastAccessedAt
  it('memories.touch increments accessCount and refreshes lastAccessedAt', () => {
    const stored = repo.memories.put({ scope: 'short', content: 'x', tags: [], importance: 0.5 });
    const initial = repo.memories.get(stored.id)!;
    const initialAccess = initial.accessCount;
    const initialTime = initial.lastAccessedAt;

    // tiny delay so timestamp differs
    const before = Date.now();
    repo.memories.touch(stored.id);
    const after = repo.memories.get(stored.id)!;
    expect(after.accessCount).toBe(initialAccess + 1);
    expect(after.lastAccessedAt).toBeGreaterThanOrEqual(before);
    expect(after.lastAccessedAt).toBeGreaterThanOrEqual(initialTime);
  });

  // 5. thoughts.put + listRecent 按 created_at desc
  it('thoughts.put + listRecent returns thoughts newest-first', async () => {
    const a = repo.thoughts.put({ kind: 'observation', content: 'first', confidence: 0.5 });
    // ensure ordering — wait a tick so timestamps differ
    await new Promise(r => setTimeout(r, 5));
    const b = repo.thoughts.put({ kind: 'inference', content: 'second', confidence: 0.7 });

    const recent = repo.thoughts.listRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].id).toBe(b.id);
    expect(recent[1].id).toBe(a.id);
  });

  // 6. thoughts.listByParent 返回子链
  it('thoughts.listByParent returns only children of the given parent', () => {
    const parent = repo.thoughts.put({ kind: 'plan', content: 'root', confidence: 0.8 });
    repo.thoughts.put({ kind: 'observation', content: 'child1', confidence: 0.5, parentId: parent.id });
    repo.thoughts.put({ kind: 'decision', content: 'child2', confidence: 0.9, parentId: parent.id });
    repo.thoughts.put({ kind: 'question', content: 'sibling', confidence: 0.5 });

    const children = repo.thoughts.listByParent(parent.id);
    expect(children).toHaveLength(2);
    expect(children.every(t => t.parentId === parent.id)).toBe(true);
  });

  // 7. tasks.start (pending → active) + finish (active → done)
  it('tasks lifecycle: put → start → finish transitions statuses correctly', () => {
    const task = repo.tasks.put({ id: 't-1', title: 'do a thing', status: 'pending' });
    expect(task.status).toBe('pending');

    repo.tasks.start(task.id);
    const active = repo.tasks.get(task.id)!;
    expect(active.status).toBe('active');
    expect(active.startedAt).toBeDefined();

    repo.tasks.finish(task.id, true, 'ok');
    const done = repo.tasks.get(task.id)!;
    expect(done.status).toBe('done');
    expect(done.finishedAt).toBeDefined();
    expect(done.result).toBe('ok');
  });

  // 8. reminders.listDue(now) 只返回 triggerAt<=now 的 pending
  it('reminders.listDue returns only pending reminders with triggerAt <= now', () => {
    const now = Date.now();
    const due = repo.reminders.put({ id: 'r-due', title: 'due', triggerAt: now - 1000, status: 'pending' });
    const future = repo.reminders.put({ id: 'r-future', title: 'future', triggerAt: now + 60_000, status: 'pending' });
    const secondDue = repo.reminders.put({ id: 'r-due2', title: 'due2', triggerAt: now - 500, status: 'pending' });
    const willFire = repo.reminders.put({ id: 'r-fire', title: 'will-fire', triggerAt: now - 100, status: 'pending' });
    repo.reminders.fire(willFire.id);

    const dueList = repo.reminders.listDue(now);
    const ids = dueList.map(r => r.id);
    expect(ids).toContain(due.id);
    expect(ids).toContain(secondDue.id);
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(willFire.id);
    expect(dueList.every(r => r.status === 'pending')).toBe(true);
  });
});