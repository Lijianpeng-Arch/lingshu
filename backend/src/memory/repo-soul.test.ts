/**
 * MemoryRepo × Soul 双写测试 (Task 3.5)
 *
 * 验收点:
 * - 不接 Soul 时, append/query 完全本地可用 (降级路径)
 * - 接 Soul 且 healthy 时, append 双写 (本地 + Soul), query 合并两边结果去重
 * - Soul 失败时仅本地成功, 不抛错
 *
 * 测试不真起 Soul 子进程, 用 fake SoulBridge stub 模拟 healthy / unhealthy。
 * 最后一个 case 是 E2E: 起一个真 http.createServer mock Soul, 跑完整双写往返。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { MemoryRepoClient, type MemoryRepoOpts } from './repo.js';
import type { SoulBridge } from '../soul-bridge.js';
import { SoulBridge as RealSoulBridge } from '../soul-bridge.js';

describe('MemoryRepo with Soul', () => {
  let dir: string;
  let dbPath: string;
  let activeRepo: MemoryRepoClient | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lingshu-memsoul-'));
    dbPath = join(dir, 'test.sqlite');
    activeRepo = null;
  });
  afterEach(() => {
    // 必须先关 DB, 否则 WAL 文件在 Windows 上锁住 rmSync (EPERM)
    if (activeRepo) {
      try { activeRepo.close(); } catch { /* ignore */ }
      activeRepo = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // Brief Step 1 — 无 Soul 时本地写入可用
  it('append writes locally even without soul', async () => {
    const opts: MemoryRepoOpts = { dbPath, soulBridge: null };
    const repo = activeRepo = new MemoryRepoClient(opts);
    const id = await repo.append('fact', '用户喜欢广州');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const results = await repo.query('广州');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.content === '用户喜欢广州')).toBe(true);
  });

  // 接 Soul 但 unhealthy → 完全本地 (不调用 Soul, 不抛错)
  it('append falls back to local-only when Soul unhealthy', async () => {
    let appendCalled = 0;
    const fakeBridge: Partial<SoulBridge> = {
      healthy: () => false,
      appendMemory: async () => { appendCalled++; return { id: 'soul-id' }; },
      queryMemory: async () => { appendCalled++; return []; },
    };
    const repo = activeRepo = new MemoryRepoClient({ dbPath, soulBridge: fakeBridge as SoulBridge });
    const id = await repo.append('fact', '今天天气好');
    expect(typeof id).toBe('string');
    expect(appendCalled).toBe(0); // unhealthy → 不调 Soul
    const results = await repo.query('天气');
    expect(results.length).toBeGreaterThan(0);
  });

  // 接 Soul 且 healthy → append 双写, query 合并去重
  it('append dual-writes to Soul when healthy', async () => {
    const appendedToSoul: Array<{ kind: string; content: string; tags: string[] }> = [];
    const fakeBridge: Partial<SoulBridge> = {
      healthy: () => true,
      appendMemory: async (kind, content, tags = []) => {
        appendedToSoul.push({ kind, content, tags });
        return { id: `soul-${appendedToSoul.length}` };
      },
      queryMemory: async (_q, limit = 10) => {
        // Soul 端"返回"刚 append 的那条 (模拟远端检索)
        return appendedToSoul
          .filter(a => a.content.includes('咖啡'))
          .map(a => ({ id: `soul-${appendedToSoul.indexOf(a) + 1}`, content: a.content, score: 0.95 }))
          .slice(0, limit);
      },
    };
    const repo = activeRepo = new MemoryRepoClient({ dbPath, soulBridge: fakeBridge as SoulBridge });
    const id = await repo.append('fact', '用户喜欢咖啡', ['user:preference']);
    expect(typeof id).toBe('string');
    expect(appendedToSoul).toHaveLength(1);
    expect(appendedToSoul[0].content).toBe('用户喜欢咖啡');
    expect(appendedToSoul[0].tags).toEqual(['user:preference']);

    const results = await repo.query('咖啡');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.content === '用户喜欢咖啡')).toBe(true);
  });

  // Soul append 抛错 → 本地仍成功, 不抛给调用方
  it('append survives Soul appendMemory throwing', async () => {
    const fakeBridge: Partial<SoulBridge> = {
      healthy: () => true,
      appendMemory: async () => { throw new Error('soul HTTP 500'); },
      queryMemory: async () => [],
    };
    const repo = activeRepo = new MemoryRepoClient({ dbPath, soulBridge: fakeBridge as SoulBridge });
    // 必须不抛错
    const id = await repo.append('fact', '重要的事实');
    expect(typeof id).toBe('string');
    // 本地有这条
    const results = await repo.query('重要');
    expect(results.some(r => r.content === '重要的事实')).toBe(true);
  });

  // query 时 Soul 返回新结果 (本地没有的) → 合并, 不丢失
  it('query merges Soul-only results into the response', async () => {
    const fakeBridge: Partial<SoulBridge> = {
      healthy: () => true,
      appendMemory: async () => ({ id: 'soul-x' }),
      queryMemory: async () => [
        { id: 'soul-1', content: 'Soul 独有的远程记忆', score: 0.9 },
      ],
    };
    const repo = activeRepo = new MemoryRepoClient({ dbPath, soulBridge: fakeBridge as SoulBridge });
    // 本地写一条不重叠的
    await repo.append('fact', '本地独有的记忆');
    // query 一个 Soul 会命中但本地不命中的关键词 — 但 query 按内容包含过滤,
    // 这里直接 query 空 query → 两边都返回 → 验证合并去重
    const results = await repo.query('独有');
    // 本地有"本地独有的记忆", Soul fake 返回"Soul 独有的远程记忆"
    expect(results.length).toBe(2);
    const contents = results.map(r => r.content);
    expect(contents).toContain('本地独有的记忆');
    expect(contents).toContain('Soul 独有的远程记忆');
  });

  // Soul query 抛错 → 本地结果仍返回, 不抛
  it('query survives Soul queryMemory throwing', async () => {
    const fakeBridge: Partial<SoulBridge> = {
      healthy: () => true,
      appendMemory: async () => ({ id: 'soul-x' }),
      queryMemory: async () => { throw new Error('soul HTTP 500'); },
    };
    const repo = activeRepo = new MemoryRepoClient({ dbPath, soulBridge: fakeBridge as SoulBridge });
    await repo.append('fact', '本地内容');
    const results = await repo.query('本地');
    expect(results.some(r => r.content === '本地内容')).toBe(true);
  });

  // 去重: 本地和 Soul 返回相同 content → 只出现一次
  it('query deduplicates identical content from local + Soul', async () => {
    const fakeBridge: Partial<SoulBridge> = {
      healthy: () => true,
      appendMemory: async () => ({ id: 'soul-x' }),
      queryMemory: async () => [
        { id: 'soul-1', content: '重复内容', score: 0.9 },
      ],
    };
    const repo = activeRepo = new MemoryRepoClient({ dbPath, soulBridge: fakeBridge as SoulBridge });
    await repo.append('fact', '重复内容');
    const results = await repo.query('重复');
    const occurrences = results.filter(r => r.content === '重复内容').length;
    expect(occurrences).toBe(1);
  });

  // E2E: http.createServer() 起 mock Soul, 走真 SoulBridge HTTP 调用, 验证双写往返
  it('E2E: real SoulBridge → http.createServer mock returns 200, full dual-write round-trip', async () => {
    const mockPort = 38901; // hardcoded free port; localhost only
    // mock 端存储, append 后存数组, query 时返回命中
    const mockStore: Array<{ id: number; kind: string; content: string; tags: string[] }> = [];
    let nextId = 1;

    const handleReq = (req: IncomingMessage, res: ServerResponse): void => {
      const url = req.url ?? '';
      if (url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (url === '/memory/append' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              kind: string; content: string; tags: string[];
            };
            const id = nextId++;
            mockStore.push({ id, kind: body.kind, content: body.content, tags: body.tags });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: `soul-${id}` }));
          } catch {
            res.writeHead(400);
            res.end('bad request');
          }
        });
        return;
      }
      if (url.startsWith('/memory/query') && req.method === 'GET') {
        const u = new URL(url, 'http://127.0.0.1');
        const q = u.searchParams.get('q') ?? '';
        const limit = Number(u.searchParams.get('limit') ?? '10');
        const matched = mockStore
          .filter(m => m.content.includes(q))
          .slice(0, limit)
          .map(m => ({ id: `soul-${m.id}`, content: m.content, score: 0.88 }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(matched));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    };

    const server: Server = createServer(handleReq);
    await new Promise<void>((resolve) => server.listen(mockPort, '127.0.0.1', () => resolve()));

    // 起真 SoulBridge, 但跳过 start() (避免 spawn Python), 强制 _healthy=true 且 proc 非空
    // 这样 appendMemory/queryMemory 会真的去打 mock HTTP
    const bridge = new RealSoulBridge({
      pythonCmd: 'python',
      soulDir: '.',
      port: mockPort,
    });
    // 强制跳过健康检查 — 直接标记 healthy 且伪造非空 proc, 走真 HTTP 调用路径
    type BridgeInternal = { _healthy: boolean; _lastHealthCheck: number; proc: unknown };
    (bridge as unknown as BridgeInternal)._healthy = true;
    (bridge as unknown as BridgeInternal)._lastHealthCheck = Date.now();
    (bridge as unknown as BridgeInternal).proc = {}; // healthy() 检查 proc !== null
    expect(bridge.healthy()).toBe(true);

    try {
      const repo = activeRepo = new MemoryRepoClient({ dbPath, soulBridge: bridge });
      // append 双写
      const localId = await repo.append('fact', 'E2E mock Soul 双写测试', ['e2e', 'mock']);
      expect(typeof localId).toBe('string');
      expect(localId.length).toBeGreaterThan(0);
      expect(mockStore).toHaveLength(1);
      expect(mockStore[0].content).toBe('E2E mock Soul 双写测试');
      expect(mockStore[0].tags).toEqual(['e2e', 'mock']);
      expect(mockStore[0].kind).toBe('fact');

      // query 走真 HTTP → mock 返回命中, 本地+合并
      const results = await repo.query('双写');
      expect(results.length).toBeGreaterThan(0);
      const contents = results.map(r => r.content);
      expect(contents).toContain('E2E mock Soul 双写测试');

      // Soul 端确实收到了 (id 是 soul-1)
      const soulHits = results.filter(r => r.content === 'E2E mock Soul 双写测试');
      expect(soulHits.length).toBeGreaterThan(0);
    } finally {
      bridge.healthy(); // sanity
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});