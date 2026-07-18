import type Database from 'better-sqlite3';
type Db = Database.Database;
import { randomUUID } from 'node:crypto';
import type {
  Memory, Thought, Task, Reminder,
  MemoryScope, ThoughtKind, TaskStatus, ReminderStatus,
} from './types.js';
import { createSqlite } from '../db/sqlite.js';
import type { SoulBridge } from '../soul-bridge.js';
import { mmrRerank } from './mmr.js';
import type { MmrConfig, ScoredCandidate } from './mmr.js';
import { DEFAULT_MMR_CONFIG } from './mmr.js';

// ===== row → object mappers =====

interface MemoryRow {
  id: string;
  scope: string;
  key: string | null;
  content: string;
  tags: string;
  importance: number;
  access_count: number;
  last_accessed_at: number;
  created_at: number;
  updated_at: number;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    key: row.key ?? undefined,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ThoughtRow {
  id: string;
  parent_id: string | null;
  kind: string;
  content: string;
  confidence: number;
  created_at: number;
}

function rowToThought(row: ThoughtRow): Thought {
  return {
    id: row.id,
    parentId: row.parent_id ?? undefined,
    kind: row.kind as ThoughtKind,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  parent_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as TaskStatus,
    parentId: row.parent_id ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ReminderRow {
  id: string;
  title: string;
  content: string | null;
  trigger_at: number;
  status: string;
  related_task_id: string | null;
  created_at: number;
  fired_at: number | null;
}

function rowToReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? undefined,
    triggerAt: row.trigger_at,
    status: row.status as ReminderStatus,
    relatedTaskId: row.related_task_id ?? undefined,
    createdAt: row.created_at,
    firedAt: row.fired_at ?? undefined,
  };
}

// ===== repo interfaces =====

export interface MemoryRepo {
  put(mem: Omit<Memory, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'updatedAt'> & { id?: string }): Memory;
  get(id: string): Memory | undefined;
  getByKey(scope: MemoryScope, key: string): Memory | undefined;
  list(scope?: MemoryScope, limit?: number): Memory[];
  search(query: string, scope?: MemoryScope): Memory[];     // LIKE + tag 命中
  touch(id: string): void;                                   // accessCount++ + lastAccessedAt=now
  delete(id: string): void;
  prune(olderThanMs: number, scope: MemoryScope): number;   // 返回删除数
  promoteToLong(id: string): void;                           // scope='short' → 'long'
}

export interface ThoughtRepo {
  put(t: Omit<Thought, 'id' | 'createdAt'> & { id?: string }): Thought;
  get(id: string): Thought | undefined;
  listRecent(limit: number): Thought[];
  listByParent(parentId: string): Thought[];
  listByKind(kind: Thought['kind'], limit: number): Thought[];
  delete(id: string): void;
}

export interface TaskRepo {
  put(t: Omit<Task, 'createdAt' | 'updatedAt'> & { id?: string }): Task;
  get(id: string): Task | undefined;
  list(status?: TaskStatus, opts?: { limit?: number; offset?: number }): Task[];
  listActive(): Task[];                                       // status='active'
  start(id: string): void;                                    // pending → active, startedAt=now
  finish(id: string, ok: boolean, result?: string, error?: string): void;
  delete(id: string): void;
}

export interface ReminderRepo {
  put(r: Omit<Reminder, 'createdAt'> & { id?: string }): Reminder;
  get(id: string): Reminder | undefined;
  listDue(now: number): Reminder[];                           // triggerAt<=now AND status='pending'
  fire(id: string): void;                                     // pending → fired, firedAt=now
  dismiss(id: string): void;
  delete(id: string): void;
}

export interface MemoryRepositories {
  memories: MemoryRepo;
  thoughts: ThoughtRepo;
  tasks: TaskRepo;
  reminders: ReminderRepo;
}

export function createMemoryRepo(db: Db): MemoryRepositories {
  // ===== memories =====
  const memInsert = db.prepare(`INSERT INTO memories
    (id, scope, key, content, tags, importance, access_count, last_accessed_at, created_at, updated_at)
    VALUES (@id, @scope, @key, @content, @tags, @importance, @access_count, @last_accessed_at, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      scope=excluded.scope, key=excluded.key, content=excluded.content,
      tags=excluded.tags, importance=excluded.importance, updated_at=excluded.updated_at`);
  const memGet = db.prepare('SELECT * FROM memories WHERE id = ?');
  const memGetByKey = db.prepare('SELECT * FROM memories WHERE scope = ? AND key = ?');
  const memListAll = db.prepare('SELECT * FROM memories ORDER BY last_accessed_at DESC LIMIT ?');
  const memListByScope = db.prepare('SELECT * FROM memories WHERE scope = ? ORDER BY last_accessed_at DESC LIMIT ?');
  const memSearchAll = db.prepare(`SELECT * FROM memories
    WHERE content LIKE ? OR tags LIKE ?
    ORDER BY last_accessed_at DESC LIMIT 100`);
  const memSearchByScope = db.prepare(`SELECT * FROM memories
    WHERE scope = ? AND (content LIKE ? OR tags LIKE ?)
    ORDER BY last_accessed_at DESC LIMIT 100`);
  const memTouch = db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`);
  const memDelete = db.prepare('DELETE FROM memories WHERE id = ?');
  const memPrune = db.prepare(`DELETE FROM memories
    WHERE scope = ? AND importance < 0.3 AND last_accessed_at < ?`);
  const memPromote = db.prepare(`UPDATE memories SET scope = 'long', updated_at = ? WHERE id = ?`);

  const memories: MemoryRepo = {
    put(mem) {
      const now = Date.now();
      const id = mem.id ?? randomUUID();
      memInsert.run({
        id,
        scope: mem.scope,
        key: mem.key ?? null,
        content: mem.content,
        tags: JSON.stringify(mem.tags ?? []),
        importance: mem.importance,
        access_count: 0,
        last_accessed_at: now,
        created_at: now,
        updated_at: now,
      });
      const stored = memGet.get(id) as MemoryRow | undefined;
      return rowToMemory(stored!);
    },
    get(id) {
      const row = memGet.get(id) as MemoryRow | undefined;
      return row ? rowToMemory(row) : undefined;
    },
    getByKey(scope, key) {
      const row = memGetByKey.get(scope, key) as MemoryRow | undefined;
      return row ? rowToMemory(row) : undefined;
    },
    list(scope, limit = 100) {
      const rows = scope
        ? memListByScope.all(scope, limit) as MemoryRow[]
        : memListAll.all(limit) as MemoryRow[];
      return rows.map(rowToMemory);
    },
    search(query, scope) {
      const like = `%${query}%`;
      const rows = scope
        ? memSearchByScope.all(scope, like, like) as MemoryRow[]
        : memSearchAll.all(like, like) as MemoryRow[];
      return rows.map(rowToMemory);
    },
    touch(id) {
      memTouch.run(Date.now(), id);
    },
    delete(id) {
      memDelete.run(id);
    },
    prune(olderThanMs, scope) {
      const cutoff = Date.now() - olderThanMs;
      return memPrune.run(cutoff, scope).changes;
    },
    promoteToLong(id) {
      memPromote.run(Date.now(), id);
    },
  };

  // ===== thoughts =====
  const thoughtInsert = db.prepare(`INSERT INTO thoughts
    (id, parent_id, kind, content, confidence, created_at)
    VALUES (@id, @parent_id, @kind, @content, @confidence, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      parent_id=excluded.parent_id, kind=excluded.kind,
      content=excluded.content, confidence=excluded.confidence`);
  const thoughtGet = db.prepare('SELECT * FROM thoughts WHERE id = ?');
  const thoughtRecent = db.prepare('SELECT * FROM thoughts ORDER BY created_at DESC LIMIT ?');
  const thoughtByParent = db.prepare('SELECT * FROM thoughts WHERE parent_id = ? ORDER BY created_at DESC');
  const thoughtByKind = db.prepare('SELECT * FROM thoughts WHERE kind = ? ORDER BY created_at DESC LIMIT ?');
  const thoughtDelete = db.prepare('DELETE FROM thoughts WHERE id = ?');

  const thoughts: ThoughtRepo = {
    put(t) {
      const id = t.id ?? randomUUID();
      const createdAt = Date.now();
      thoughtInsert.run({
        id,
        parent_id: t.parentId ?? null,
        kind: t.kind,
        content: t.content,
        confidence: t.confidence,
        created_at: createdAt,
      });
      const row = thoughtGet.get(id) as ThoughtRow | undefined;
      return rowToThought(row!);
    },
    get(id) {
      const row = thoughtGet.get(id) as ThoughtRow | undefined;
      return row ? rowToThought(row) : undefined;
    },
    listRecent(limit) {
      const rows = thoughtRecent.all(limit) as ThoughtRow[];
      return rows.map(rowToThought);
    },
    listByParent(parentId) {
      const rows = thoughtByParent.all(parentId) as ThoughtRow[];
      return rows.map(rowToThought);
    },
    listByKind(kind, limit) {
      const rows = thoughtByKind.all(kind, limit) as ThoughtRow[];
      return rows.map(rowToThought);
    },
    delete(id) {
      thoughtDelete.run(id);
    },
  };

  // ===== tasks =====
  const taskInsert = db.prepare(`INSERT INTO tasks
    (id, title, description, status, parent_id, started_at, finished_at, result, error, created_at, updated_at)
    VALUES (@id, @title, @description, @status, @parent_id, @started_at, @finished_at, @result, @error, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, description=excluded.description,
      status=excluded.status, parent_id=excluded.parent_id,
      started_at=excluded.started_at, finished_at=excluded.finished_at,
      result=excluded.result, error=excluded.error, updated_at=excluded.updated_at`);
  const taskGet = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const taskListAll = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ? OFFSET ?');
  const taskListByStatus = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?');
  const taskListActive = db.prepare(`SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at DESC`);
  const taskStart = db.prepare(`UPDATE tasks SET status = 'active', started_at = ?, updated_at = ? WHERE id = ?`);
  const taskFinish = db.prepare(`UPDATE tasks SET status = ?, finished_at = ?, result = ?, error = ?, updated_at = ? WHERE id = ?`);
  const taskDelete = db.prepare('DELETE FROM tasks WHERE id = ?');

  const tasks: TaskRepo = {
    put(t) {
      const now = Date.now();
      const id = t.id ?? randomUUID();
      taskInsert.run({
        id,
        title: t.title,
        description: t.description ?? null,
        status: t.status ?? 'pending',
        parent_id: t.parentId ?? null,
        started_at: t.startedAt ?? null,
        finished_at: t.finishedAt ?? null,
        result: t.result ?? null,
        error: t.error ?? null,
        created_at: now,
        updated_at: now,
      });
      const row = taskGet.get(id) as TaskRow | undefined;
      return rowToTask(row!);
    },
    get(id) {
      const row = taskGet.get(id) as TaskRow | undefined;
      return row ? rowToTask(row) : undefined;
    },
    list(status, opts) {
      const limit = opts?.limit ?? 100;
      const offset = opts?.offset ?? 0;
      const rows = status
        ? taskListByStatus.all(status, limit, offset) as TaskRow[]
        : taskListAll.all(limit, offset) as TaskRow[];
      return rows.map(rowToTask);
    },
    listActive() {
      const rows = taskListActive.all() as TaskRow[];
      return rows.map(rowToTask);
    },
    start(id) {
      const now = Date.now();
      taskStart.run(now, now, id);
    },
    finish(id, ok, result, error) {
      const now = Date.now();
      taskFinish.run(ok ? 'done' : 'failed', now, result ?? null, error ?? null, now, id);
    },
    delete(id) {
      taskDelete.run(id);
    },
  };

  // ===== reminders =====
  const remInsert = db.prepare(`INSERT INTO reminders
    (id, title, content, trigger_at, status, related_task_id, created_at, fired_at)
    VALUES (@id, @title, @content, @trigger_at, @status, @related_task_id, @created_at, @fired_at)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, content=excluded.content,
      trigger_at=excluded.trigger_at, status=excluded.status,
      related_task_id=excluded.related_task_id, fired_at=excluded.fired_at`);
  const remGet = db.prepare('SELECT * FROM reminders WHERE id = ?');
  const remListDue = db.prepare(`SELECT * FROM reminders
    WHERE status = 'pending' AND trigger_at <= ?
    ORDER BY trigger_at ASC`);
  const remFire = db.prepare(`UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?`);
  const remDismiss = db.prepare(`UPDATE reminders SET status = 'dismissed' WHERE id = ?`);
  const remDelete = db.prepare('DELETE FROM reminders WHERE id = ?');

  const reminders: ReminderRepo = {
    put(r) {
      const now = Date.now();
      const id = r.id ?? randomUUID();
      remInsert.run({
        id,
        title: r.title,
        content: r.content ?? null,
        trigger_at: r.triggerAt,
        status: r.status ?? 'pending',
        related_task_id: r.relatedTaskId ?? null,
        created_at: now,
        fired_at: r.firedAt ?? null,
      });
      const row = remGet.get(id) as ReminderRow | undefined;
      return rowToReminder(row!);
    },
    get(id) {
      const row = remGet.get(id) as ReminderRow | undefined;
      return row ? rowToReminder(row) : undefined;
    },
    listDue(now) {
      const rows = remListDue.all(now) as ReminderRow[];
      return rows.map(rowToReminder);
    },
    fire(id) {
      remFire.run(Date.now(), id);
    },
    dismiss(id) {
      remDismiss.run(id);
    },
    delete(id) {
      remDelete.run(id);
    },
  };

  return { memories, thoughts, tasks, reminders };
}

// ===== MemoryRepoClient 高层类 (Phase W3.5) =====
//
// 包装 createMemoryRepo, 对外暴露简化的 append/query 接口, 并支持可选 Soul 双写:
// - append: 本地先写 (始终成功) → Soul 健康时双写 (失败不抛)
// - query:  本地查 + Soul 健康时远程查, 结果合并按 content 去重
//
// Soul 不可用时 (healthy()=false 或抛错) 走纯本地降级路径, 调用方不感知差异。
// 这是 Phase W3 主线任务的最后一步 — 后续 MainLoop (Phase W4) 直接调它。
//
// 命名说明: 不直接叫 MemoryRepo 是为了不和同文件 MemoryRepo interface (line ~117,
// 低层 put/get 风格) 冲突; 这里提供 "append/query" 高层接口给上层调用者。

export interface MemoryRepoOpts {
  dbPath: string;
  soulBridge?: SoulBridge | null;
  /** MMR 重排配置 (Phase A: 记忆去重). 传 undefined = 启用默认配置; 显式传 {enabled:false} = 关闭. */
  mmr?: MmrConfig;
}

/** Soul append/query 返回的远程条目 — 转成本地 Memory 形状供合并。 */
interface RemoteMemory {
  id: string;
  content: string;
  /** 远端检索分数 (0-1), 用作 importance 的代理, 默认 0.5 */
  score?: number;
}

export class MemoryRepoClient {
  private readonly repos: MemoryRepositories;
  private readonly soulBridge: SoulBridge | null;
  private readonly db: Db;
  /** MMR 重排配置 — 留作公开以便运行时切换 (测试 / 调试) */
  public mmr: MmrConfig;

  constructor(opts: MemoryRepoOpts) {
    this.soulBridge = opts.soulBridge ?? null;
    this.db = createSqlite(opts.dbPath);
    this.repos = createMemoryRepo(this.db);
    // 未传 → 默认启用; 显式传 → 用调用方的值 (可关闭)
    // 默认关闭: 保持向后兼容 (现有 670 测试假设 last_accessed_at 排序)
    // 启用方法: 传 `mmr: { ...DEFAULT_MMR_CONFIG }` 进来, 或运行时 `repo.mmr.enabled = true`
    this.mmr = opts.mmr ?? { ...DEFAULT_MMR_CONFIG, enabled: false };
  }

  /** 关闭底层 SQLite 连接。测试清理用。 */
  close(): void {
    this.db.close();
  }

  /**
   * append: 写入一条记忆。
   * - 本地 SQLite 始终写入 (这是 source of truth)。
   * - 若 soulBridge 健康, 异步尝试双写到 Soul (失败仅日志, 不抛)。
   * - 返回本地 id (string)。
   *
   * kind: 自由文本 (e.g. 'fact' / 'observation' / 'plan'), Soul 用于索引分组,
   *       本地 scope 默认 'short'。
   * tags: 任意标签数组。
   */
  async append(kind: string, content: string, tags: string[] = []): Promise<string> {
    // 1. 本地写 — 始终成功
    const stored = this.repos.memories.put({
      scope: 'short',
      content,
      tags: [...tags, `kind:${kind}`],
      importance: 0.5,
    });

    // TODO(W4/W5): Persist Soul-side row ID alongside local row for future
    // delete-on-Soul / read-through-to-Soul. Currently no linkage.

    // 2. Soul 双写 — best-effort
    if (this.soulBridge && this.soulBridge.healthy()) {
      try {
        await this.soulBridge.appendMemory(kind, content, tags);
      } catch (err) {
        // 不抛 — 本地已成功, Soul 失败降级
        // eslint-disable-next-line no-console
        console.warn('[MemoryRepo] Soul append 失败, 仅本地写入:', (err as Error).message);
      }
    }

    return stored.id;
  }

  /**
   * query: 按关键词搜索记忆。
   * - 本地搜索始终执行。
   * - Soul 健康时, 同时远程查, 合并结果按 content 去重。
   * - Soul 失败时静默降级, 仅本地。
   *
   * 返回按 last_accessed_at / score 综合排序的 Memory 列表 (本地条目优先)。
   *
   * MMR 重排 (Phase A):
   * - 启用时, 合并结果在排序+截断 limit 之前会过一遍 mmrRerank
   * - relevance 由 importance * 0.6 + accessCount*0.4 归一化估算 (无真实 embedding)
   * - enabled=false 时走原 sort 路径, 与旧版字节级一致 (供 fallback)
   */
  async query(q: string, limit = 20): Promise<Memory[]> {
    // 1. 本地查询
    const local = this.repos.memories.search(q).slice(0, limit);

    // 2. Soul 查询 (best-effort)
    let remote: RemoteMemory[] = [];
    if (this.soulBridge && this.soulBridge.healthy()) {
      try {
        remote = await this.soulBridge.queryMemory(q, limit);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[MemoryRepo] Soul query 失败, 仅本地:', (err as Error).message);
        remote = [];
      }
    }

    let merged: Memory[];
    if (remote.length === 0) {
      merged = local;
    } else {
      // 3. 合并: 本地在前, 远程按 content 去重追加
      const seen = new Set(local.map(m => m.content));
      merged = [...local];
      for (const r of remote) {
        if (seen.has(r.content)) continue;
        seen.add(r.content);
        // 远程条目转 Memory 形状 — id 用 'soul:' 前缀区分来源
        merged.push({
          id: `soul:${r.id}`,
          scope: 'short',
          content: r.content,
          tags: [],
          importance: typeof r.score === 'number' ? r.score : 0.5,
          accessCount: 0,
          lastAccessedAt: 0, // 远程条目无访问时间, 排到末尾
          createdAt: 0,
          updatedAt: 0,
        });
      }
    }

    // 4. MMR 重排 (开启时): 把重要性/热度当作 relevance 代理, 走多样性 rerank
    if (this.mmr.enabled) {
      // relevance 估算: 0.6 重要性 + 0.4 访问次数 (归一化到 [0, 1])
      // 远程条目 lastAccessedAt=0, importance 直接是 score 代理, 已天然在 [0,1]
      const cands: ScoredCandidate<Memory>[] = merged.map(m => ({
        item: m,
        relevance: clamp01(m.importance * 0.6 + Math.min(m.accessCount, 10) / 10 * 0.4),
      }));
      const reranked = mmrRerank(cands, this.mmr);
      return reranked.slice(0, limit);
    }

    // 5. 旧版路径 (MMR 关闭): 严格按 last_accessed_at 降序, 截断 limit
    merged.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    return merged.slice(0, limit);
  }
}

/** 把数值夹到 [0, 1] */
function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}