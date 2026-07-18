import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleScheduler } from './scheduler.js';

describe('idle/scheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('register + start: 每 interval 触发所有 task', () => {
    const a = vi.fn();
    const b = vi.fn();
    const s = createIdleScheduler({ intervalMs: 1000 });
    s.register(a, { name: 'a' });
    s.register(b, { name: 'b' });
    s.start();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('unregister: 从列表移除, 不再触发', () => {
    const a = vi.fn();
    const s = createIdleScheduler({ intervalMs: 1000 });
    const unregister = s.register(a, { name: 'a' });
    s.start();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    unregister();
    vi.advanceTimersByTime(5000);
    expect(a).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('enabled=false: 注册但不跑', () => {
    const a = vi.fn();
    const s = createIdleScheduler({ intervalMs: 1000 });
    s.register(a, { name: 'a', enabled: false });
    s.start();
    vi.advanceTimersByTime(5000);
    expect(a).not.toHaveBeenCalled();
    s.stop();
  });

  it('task 抛异常 → 其他 task 继续 (resilient)', () => {
    const a = vi.fn(() => { throw new Error('a-boom'); });
    const b = vi.fn();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = createIdleScheduler({ intervalMs: 1000 });
    s.register(a, { name: 'a' });
    s.register(b, { name: 'b' });
    s.start();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    consoleErr.mockRestore();
    s.stop();
  });

  it('runOnce(): 强制跑一次, 不依赖时钟', async () => {
    const a = vi.fn();
    const s = createIdleScheduler();
    s.register(a, { name: 'a' });
    await s.runOnce();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('taskCount: 反映已注册数', () => {
    const s = createIdleScheduler();
    expect(s.taskCount).toBe(0);
    s.register(() => {});
    s.register(() => {});
    expect(s.taskCount).toBe(2);
    s.register(() => {}, { enabled: false });
    expect(s.taskCount).toBe(3);
  });
});
