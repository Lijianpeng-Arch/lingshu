import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHeartbeat, type Heartbeat } from './heartbeat.js';

describe('idle/heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start: 立即调度第一个 tick, 不立即执行', () => {
    const onTick = vi.fn();
    const hb: Heartbeat = createHeartbeat({ intervalMs: 1000, onTick, now: () => 1_000 });
    hb.start();
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    hb.stop();
  });

  it('start: 每 intervalMs 触发一次 (默认 5min = 300_000ms)', () => {
    const onTick = vi.fn();
    const hb = createHeartbeat({ intervalMs: 300_000, onTick, now: () => 0 });
    hb.start();
    vi.advanceTimersByTime(300_000);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_000);
    expect(onTick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(300_000);
    expect(onTick).toHaveBeenCalledTimes(3);
    hb.stop();
  });

  it('stop: 立即停止后续 tick', () => {
    const onTick = vi.fn();
    const hb = createHeartbeat({ intervalMs: 1000, onTick, now: () => 0 });
    hb.start();
    vi.advanceTimersByTime(500);
    hb.stop();
    vi.advanceTimersByTime(2000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('onTick 抛异常 → heartbeat 仍继续 (resilient)', () => {
    const onTick = vi.fn(() => {
      throw new Error('boom');
    });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hb = createHeartbeat({ intervalMs: 1000, onTick, now: () => 0 });
    hb.start();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
    hb.stop();
  });

  it('now: 自定义 now() 被使用', () => {
    const onTick = vi.fn();
    const calls: number[] = [];
    const hb = createHeartbeat({
      intervalMs: 1000,
      onTick,
      now: () => {
        const t = calls.length === 0 ? 0 : 1000;
        calls.push(t);
        return t;
      },
    });
    hb.start();
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    // context 里包含 lastTickAt
    const ctx = onTick.mock.calls[0][0];
    expect(typeof ctx.lastTickAt).toBe('number');
    hb.stop();
  });
});
