/**
 * SoulBridge — backend ↔ Soul 子进程 HTTP 桥 (Phase W3.3)
 *
 * 借鉴白龙马: backend spawn Python 子进程 + HTTP 127.0.0.1:<port>。
 * - start: spawn + 等 /health 200 (timeout)
 * - healthy: 当前是否健康 (最近 healthcheck 成功且进程存活)
 * - appendMemory / queryMemory: HTTP 调 Soul
 * - shutdown: SIGTERM + 等 5s 优雅退出, 超时 SIGKILL
 *
 * 失败降级: Soul 不可用时, bridge.healthy()=false, 调用方走 no-soul 路径(只本地 memory)。
 *
 * 关于 PYTHONPATH: Soul 包在 <soulDir>/src/soul/, 模块名 soul.api。
 * pytest 靠 pyproject `pythonpath = ["src"]` 找到它; spawn uvicorn 时没有 pytest,
 * 所以这里把 <soulDir>/src 注入 PYTHONPATH, 保证 `soul.api:app` 可导入。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export interface SoulBridgeOpts {
  pythonCmd: string;
  soulDir: string;
  port: number;
  healthTimeoutMs?: number;
}

export interface AppendResult {
  id: string;
}

export interface QueryResult {
  id: string;
  content: string;
  score: number;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export class SoulBridge {
  private proc: ChildProcess | null = null;
  private readonly opts: Required<SoulBridgeOpts>;
  private _healthy = false;
  private _lastHealthCheck = 0;

  constructor(opts: SoulBridgeOpts) {
    this.opts = {
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
      ...opts,
    };
  }

  /**
   * spawn Soul 子进程并轮询 /health 直到就绪或超时。
   * 幂等: 已启动则直接返回当前健康状态。
   * 返回 boolean — false 表示未就绪(调用方应走 no-soul 降级), 不抛错。
   */
  async start(): Promise<boolean> {
    if (this.proc) return this._healthy;
    try {
      // <soulDir>/src 注入 PYTHONPATH, 让 `soul.api` 可导入 (src-layout)。
      const srcDir = path.join(this.opts.soulDir, 'src');
      const existingPath = process.env['PYTHONPATH'];
      const pythonPath = existingPath ? `${srcDir}${path.delimiter}${existingPath}` : srcDir;

      this.proc = spawn(
        this.opts.pythonCmd,
        ['-m', 'uvicorn', 'soul.api:app', '--host', '127.0.0.1', '--port', String(this.opts.port)],
        {
          cwd: this.opts.soulDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env: { ...process.env, PYTHONPATH: pythonPath },
        },
      );
      this.proc.on('exit', () => {
        this._healthy = false;
        this.proc = null;
      });
      // spawn 本身失败(命令不存在)走 'error' 事件, 不能让它变成 unhandled。
      this.proc.on('error', () => {
        this._healthy = false;
        this.proc = null;
      });
      return await this.waitForHealth();
    } catch {
      this._healthy = false;
      this.proc = null;
      return false;
    }
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.opts.healthTimeoutMs;
    while (Date.now() < deadline) {
      // 进程若已退出(spawn 失败或崩溃)提前放弃, 不空转到超时。
      if (this.proc === null) {
        this._healthy = false;
        return false;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${this.opts.port}/health`);
        if (r.ok) {
          this._healthy = true;
          this._lastHealthCheck = Date.now();
          return true;
        }
      } catch {
        // 尚未就绪 — 继续轮询
      }
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_HEALTH_CHECK_INTERVAL_MS));
    }
    this._healthy = false;
    return false;
  }

  /** 当前是否健康: 最近一次 healthcheck 成功且进程仍存活。 */
  healthy(): boolean {
    return this._healthy && this.proc !== null;
  }

  /** 最近一次成功 healthcheck 的时间戳 (ms), 0 = 从未成功。 */
  lastHealthCheckMs(): number {
    return this._lastHealthCheck;
  }

  async appendMemory(kind: string, content: string, tags: string[] = []): Promise<AppendResult> {
    if (!this.healthy()) throw new Error('soul not healthy');
    const r = await fetch(`http://127.0.0.1:${this.opts.port}/memory/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, content, tags }),
    });
    if (!r.ok) throw new Error(`soul /memory/append ${r.status}`);
    return (await r.json()) as AppendResult;
  }

  async queryMemory(q: string, limit = 10): Promise<QueryResult[]> {
    if (!this.healthy()) throw new Error('soul not healthy');
    const url = new URL(`http://127.0.0.1:${this.opts.port}/memory/query`);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', String(limit));
    const r = await fetch(url);
    if (!r.ok) throw new Error(`soul /memory/query ${r.status}`);
    return (await r.json()) as QueryResult[];
  }

  /** SIGTERM 优雅关闭, 5s 内没退出则 SIGKILL。幂等。 */
  async shutdown(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this._healthy = false;
    proc.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => proc.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
    // SIGTERM 没在 SHUTDOWN_TIMEOUT_MS 内退出则强制 SIGKILL。
    // 注意: proc.killed 在 kill() 后可能仍为 false (Node 行为), 所以无条件调,
    // 对已退出的进程 kill() 是 no-op, 不会抛错。
    proc.kill('SIGKILL');
  }
}

let bridgeInstance: SoulBridge | null = null;

/**
 * Resolve default soulDir with 3-tier priority:
 *   1. process.env['LINGSHU_SOUL_DIR'] (explicit override)
 *   2. <cwd>/soul (portable, works in any deployment layout)
 *   3. D:/lingshu/lingshu/soul (historical fallback for backwards compat)
 */
function resolveDefaultSoulDir(): string {
  const fromEnv = process.env['LINGSHU_SOUL_DIR'];
  if (fromEnv) return fromEnv;
  const cwdRelative = path.resolve(process.cwd(), 'soul');
  // cwd-relative resolves to *some* absolute path even if the directory doesn't
  // exist yet — that's fine, SoulBridge.start() degrades gracefully on spawn failure.
  // We only return the historical fallback if the cwd-relative candidate doesn't
  // exist AND the historical path does (i.e. looks like the old monorepo layout).
  const legacyFallback = 'D:/lingshu/lingshu/soul';
  try {
    if (require('node:fs').existsSync(cwdRelative)) return cwdRelative;
  } catch {
    // ignore — fall through to legacy
  }
  return legacyFallback;
}

/** 进程级单例 — server.ts 用它接线 (Task 3.4)。 */
export function getSoulBridge(): SoulBridge {
  if (!bridgeInstance) {
    bridgeInstance = new SoulBridge({
      pythonCmd: process.env['LINGSHU_SOUL_PYTHON'] ?? 'python',
      soulDir: resolveDefaultSoulDir(),
      port: Number(process.env['LINGSHU_SOUL_PORT'] ?? 3721),
    });
  }
  return bridgeInstance;
}

/** 测试专用: 关掉当前单例并清空, 避免测试间残留子进程。 */
export function resetSoulBridgeForTest(): void {
  if (bridgeInstance) {
    void bridgeInstance.shutdown();
  }
  bridgeInstance = null;
}
