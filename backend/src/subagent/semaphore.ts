/**
 * Simple async semaphore for bounding concurrency of sub-agent spawns.
 * (H8: prevent fan-out DoW via unbounded parallel LLM calls.)
 *
 * Usage:
 *   await sem.acquire();   // blocks until slot is free
 *   try { ... } finally { sem.release(); }
 *
 * Or bulk-acquire: `await Promise.all(tasks.map(() => sem.acquire()))`
 * and bulk-release in each task's finally block.
 */

import { CONCURRENCY } from '../config/constants.js';

export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(public readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore max must be a positive integer, got ${max}`);
    }
  }

  /** Current number of acquired slots. Test-only. */
  get activeCount(): number {
    return this.active;
  }

  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    if (this.active <= 0) {
      throw new Error('Semaphore.release() called without matching acquire()');
    }
    this.active--;
    const next = this.waiters.shift();
    if (next) {
      // hand the slot to the next waiter (don't decrement first)
      this.active++;
      next();
    }
  }
}

/**
 * Global cap on concurrent sub-agent spawns. Defaults to CONCURRENCY.SUB_AGENT_MAX
 * (currently 8) because each sub-agent can issue additional LLM/tool calls,
 * so total fan-out is exponential without a bound.
 */
export const globalSubAgentSemaphore = new Semaphore(CONCURRENCY.SUB_AGENT_MAX);