/**
 * Tick Scheduler — priority-adaptive intervals
 *
 * Borrowed from BaiLongma `scheduleNextTick()`:
 *   - 0ms    when user message pending
 *   - 10s    during first 10 awakening ticks
 *   - 30s    during active task
 *   - 60s    idle
 *   - 10min  when rate-limited
 */

export type TickReason = 'user_message' | 'awakening' | 'active_task' | 'idle';

export interface SchedulerState {
  isRateLimited: boolean;
  awakeningTicks?: number;
  reminderDueMs?: number;
}

export interface SchedulerOptions {
  onTick: () => Promise<void> | void;
  reason: () => TickReason;
  getState?: () => SchedulerState;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  triggerImmediateTick(reason: 'user_message'): Promise<void>;
  forceTickNow(reason: TickReason): Promise<void>;
}

export function computeNextInterval(reason: TickReason, state: SchedulerState): number {
  if (reason === 'user_message') return 0;
  let base: number;
  switch (reason) {
    case 'awakening': base = 10_000; break;
    case 'active_task': base = 30_000; break;
    case 'idle':
    default: base = 60_000; break;
  }
  if (state.isRateLimited) base = Math.max(base, 600_000);
  if (state.reminderDueMs !== undefined && state.reminderDueMs < base) base = state.reminderDueMs;
  return base;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await opts.onTick();
    } catch (err) {
      console.error('[scheduler] tick error:', err);
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    const reason = opts.reason();
    const state = opts.getState?.() ?? { isRateLimited: false };
    const interval = computeNextInterval(reason, state);
    timer = setTimeout(() => void tick(), interval);
  }

  return {
    start() {
      stopped = false;
      if (timer) return;
      const reason = opts.reason();
      const state = opts.getState?.() ?? { isRateLimited: false };
      const interval = computeNextInterval(reason, state);
      timer = setTimeout(() => { timer = null; void tick(); }, interval);
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    async triggerImmediateTick(reason) {
      if (reason !== 'user_message') throw new Error('triggerImmediateTick only supports reason="user_message"');
      await tick();
    },
    async forceTickNow(_reason) { await tick(); },
  };
}
