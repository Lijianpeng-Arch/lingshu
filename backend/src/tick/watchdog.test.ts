import { describe, it, expect } from 'vitest';
import { withWatchdog, WatchdogTimeout } from './watchdog.js';

describe('withWatchdog', () => {
  it('returns result when fast enough', async () => {
    const r = await withWatchdog(async () => 'ok', { timeoutMs: 100 });
    expect(r).toBe('ok');
  });
  it('rejects with WatchdogTimeout when slow', async () => {
    await expect(
      withWatchdog(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'late';
      }, { timeoutMs: 50 })
    ).rejects.toBeInstanceOf(WatchdogTimeout);
  });
  it('passes AbortSignal', async () => {
    let signal: AbortSignal | undefined;
    await withWatchdog(async (s) => { signal = s; return 'ok'; }, { timeoutMs: 100 });
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
  });
  it('marks signal aborted on timeout', async () => {
    let observed = false;
    await expect(
      withWatchdog(async (signal) => {
        await new Promise((r) => {
          signal.addEventListener('abort', () => { observed = true; r(undefined); });
          setTimeout(r, 500);
        });
        return 'unreached';
      }, { timeoutMs: 30 })
    ).rejects.toBeInstanceOf(WatchdogTimeout);
    expect(observed).toBe(true);
  });
  it('caller-supplied signal short-circuits', async () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 20);
    await expect(
      withWatchdog(async () => { await new Promise((r) => setTimeout(r, 200)); return 'x'; },
        { timeoutMs: 1000, signal: c.signal })
    ).rejects.toBeInstanceOf(WatchdogTimeout);
  });
});
