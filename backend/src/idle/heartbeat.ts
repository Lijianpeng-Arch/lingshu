/**
 * idle/heartbeat — periodic background tick
 *
 * Spec 2D — persistent main loop (Phase E)
 *
 * Borrowed from:
 *   - 白龙马 `heartbeat()` — 简单周期 tick, 默认 5 分钟
 *   - Apple Reminders / Things 3 refresh timer
 *
 * 设计:
 *   - 用 setInterval (而非递归 setTimeout) 以兼容 vitest fake timers
 *   - onTick 抛异常 → 不影响下次 (try/catch wrap)
 *   - stop 后不残留 timer (避免 tests hang / process leak)
 *   - async onTick 仅 fire-and-forget; 不阻塞下一次
 */

export interface HeartbeatOptions {
  /** Tick 间隔 (ms). 默认 5 分钟 = 300_000ms (Spec §6 DoD) */
  intervalMs?: number;
  /** 每个 tick 调用. 同步函数; async fn 包成 .catch 仍能跑 */
  onTick: (ctx: { now: number; lastTickAt: number; tickCount: number }) => void | Promise<void>;
  now?: () => number;
}

export interface Heartbeat {
  start(): void;
  stop(): void;
  /** 手动触发一次 (测试 + 调试) */
  forceTick(): Promise<void>;
  get tickCount(): number;
  get lastTickAt(): number;
  /** 是否在运行 */
  get running(): boolean;
}

export function createHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let tickCountVal = 0;
  let lastTickAtVal = 0;
  // M20: prevent overlap when a tick's async work outlasts `intervalMs`.
  // Skip the next interval tick if the previous one is still in flight.
  let inFlight = false;

  async function fireTick(): Promise<void> {
    if (inFlight) return; // skip overlapping tick
    inFlight = true;
    const at = now();
    lastTickAtVal = at;
    tickCountVal += 1;
    try {
      const result = opts.onTick({ now: at, lastTickAt: at, tickCount: tickCountVal });
      if (result && typeof (result as Promise<void>).catch === 'function') {
        await result;
      }
    } catch (err) {
      console.error('[idle/heartbeat] tick error (continuing):', err);
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      // 用 setInterval 直接 — 简化 fake timers 测试
      timer = setInterval(() => {
        if (!stopped) fireTick();
      }, intervalMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    },

    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async forceTick() {
      // M20b: actually await the async tick (was fire-and-forget).
      await fireTick();
    },

    get tickCount() {
      return tickCountVal;
    },
    get lastTickAt() {
      return lastTickAtVal;
    },
    get running() {
      return !stopped;
    },
  };
}
