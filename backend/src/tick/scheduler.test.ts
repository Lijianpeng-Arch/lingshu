import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler, computeNextInterval, type TickReason } from './scheduler.js';

describe('computeNextInterval', () => {
  it('returns 0ms when user message pending', () => {
    expect(computeNextInterval('user_message', { isRateLimited: false })).toBe(0);
  });
  it('returns 60s when idle', () => {
    expect(computeNextInterval('idle', { isRateLimited: false })).toBe(60_000);
  });
  it('returns 10min when rate-limited', () => {
    expect(computeNextInterval('idle', { isRateLimited: true })).toBe(600_000);
  });
  it('returns 10s during awakening', () => {
    expect(computeNextInterval('awakening', { isRateLimited: false })).toBe(10_000);
  });
  it('returns 30s during active task', () => {
    expect(computeNextInterval('active_task', { isRateLimited: false })).toBe(30_000);
  });
  it('respects reminder override', () => {
    expect(computeNextInterval('idle', { isRateLimited: false, reminderDueMs: 5_000 })).toBe(5_000);
  });
});

describe('createScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedules tick at computed interval', () => {
    const tick = vi.fn();
    const s = createScheduler({ onTick: tick, reason: () => 'idle' as TickReason });
    s.start();
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('triggerImmediateTick fires onTick', async () => {
    const tick = vi.fn();
    const s = createScheduler({ onTick: tick, reason: () => 'idle' as TickReason });
    s.start();
    await s.triggerImmediateTick('user_message');
    expect(tick).toHaveBeenCalled();
    s.stop();
  });

  it('stop prevents further ticks', () => {
    const tick = vi.fn();
    const s = createScheduler({ onTick: tick, reason: () => 'idle' as TickReason });
    s.start();
    s.stop();
    vi.advanceTimersByTime(120_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
