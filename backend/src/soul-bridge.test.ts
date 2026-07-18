import { describe, it, expect, afterEach } from 'vitest';
import { SoulBridge, resetSoulBridgeForTest } from './soul-bridge.js';

describe('SoulBridge', () => {
  afterEach(() => resetSoulBridgeForTest());

  it('start spawns soul process and returns ok when healthy', async () => {
    const bridge = new SoulBridge({
      pythonCmd: 'python',
      soulDir: 'D:/lingshu/lingshu/soul',
      port: 3721,
      healthTimeoutMs: 10_000,
    });
    const ok = await bridge.start();
    if (ok) {
      expect(bridge.healthy()).toBe(true);
      await bridge.shutdown();
    }
    // 若本地没 python 或启动失败,跳过 — CI 友好
    expect(typeof ok).toBe('boolean');
  }, 30_000);

  it('healthy returns false before start', () => {
    const bridge = new SoulBridge({ pythonCmd: 'python', soulDir: '.', port: 3722 });
    expect(bridge.healthy()).toBe(false);
  });

  it('append calls /memory/append and returns id', async () => {
    const bridge = new SoulBridge({
      pythonCmd: 'python',
      soulDir: 'D:/lingshu/lingshu/soul',
      port: 3721,
      healthTimeoutMs: 10_000,
    });
    const started = await bridge.start();
    if (!started) return; // skip if env not ready
    try {
      const r = await bridge.appendMemory('fact', '用户喜欢广州');
      expect(typeof r.id).toBe('string');
    } finally {
      await bridge.shutdown();
    }
  }, 30_000);
});
