/**
 * Watchdog — wraps an async function with a hard timeout.
 * Borrowed from BaiLongma `runTurnWithWatchdog()`.
 */

export class WatchdogTimeout extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.name = 'WatchdogTimeout';
  }
}

export interface WatchdogOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type WatchedFn<T> = (signal: AbortSignal) => Promise<T>;

export async function withWatchdog<T>(fn: WatchedFn<T>, opts: WatchdogOptions): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | null = null;
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onCallerAbort);
  }
  let timerFired = false;
  timeoutHandle = setTimeout(() => {
    timerFired = true;
    controller.abort();
  }, opts.timeoutMs);
  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new WatchdogTimeout(opts.timeoutMs));
    });
  });
  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
  };
  try {
    const result = await Promise.race([fn(controller.signal), timeoutPromise]);
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    if (timerFired || (controller.signal.aborted && !opts.signal?.aborted)) {
      throw new WatchdogTimeout(opts.timeoutMs);
    }
    throw err;
  }
}
