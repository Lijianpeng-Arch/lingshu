/**
 * idle/scheduler — register idle tasks for periodic execution
 *
 * Spec 2D — persistent main loop (Phase E)
 *
 * Borrowed from:
 *   - 白龙马 `idle_scheduler.py` — 注册后台任务, 统一调度
 *   - LangGraph cron job registry
 *
 * 设计:
 *   - 抽象出 "idle task" 接口, 一个 task = 一个回调
 *   - 内部用 heartbeat 跑, 5 分钟一拍
 *   - 每个 task 单独 try/catch, 一个失败不影响其他
 *   - task 可选 enabled / intervalMs 自定义
 *
 *   Task 注册靠 `register()`, 不调用 register 则该 task 不跑 (避免 hard-coded 业务).
 *   main-loop 持有 idleScheduler 实例, 在 .start() 时调 idleScheduler.start(), 在 .stop() 时调 .stop().
 */

import { createHeartbeat, type Heartbeat } from './heartbeat.js';

export type IdleTask = () => void | Promise<void>;

export interface IdleTaskOptions {
  /** 是否启用. 默认 true. */
  enabled?: boolean;
  /** 自定义间隔; 不传跟随全局 heartbeat (默认 5min) */
  intervalMs?: number;
  /** task 名 (供 debug 用) */
  name?: string;
}

export interface IdleScheduler {
  register(task: IdleTask, opts?: IdleTaskOptions): () => void;  // 返回 unregister 函数
  start(): void;
  stop(): void;
  /** 手动跑一次 (debug / test) */
  runOnce(): Promise<void>;
  get taskCount(): number;
  get running(): boolean;
}

export interface IdleSchedulerOptions {
  /** 全局 interval; 默认 5 分钟. 单个 task 可覆盖 */
  intervalMs?: number;
}

export function createIdleScheduler(opts: IdleSchedulerOptions = {}): IdleScheduler {
  const globalInterval = opts.intervalMs ?? 5 * 60 * 1000;
  const tasks: Array<{ task: IdleTask; opts: IdleTaskOptions; ref: Heartbeat }> = [];
  let heartbeat: Heartbeat | null = null;

  function defaultRun(task: IdleTask, taskOpts: IdleTaskOptions): void {
    try {
      const result = task();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          console.error(`[idle/scheduler] task "${taskOpts.name ?? 'anon'}" async error:`, err);
        });
      }
    } catch (err) {
      console.error(`[idle/scheduler] task "${taskOpts.name ?? 'anon'}" sync error:`, err);
    }
  }

  return {
    register(task, taskOpts = {}) {
      const ref = createHeartbeat({
        intervalMs: taskOpts.intervalMs ?? globalInterval,
        onTick: () => defaultRun(task, taskOpts),
      });
      const entry = { task, opts: taskOpts, ref };
      tasks.push(entry);
      // 如果整体已 running, 立即启动该 task
      if (heartbeat && heartbeat.running && taskOpts.enabled !== false) {
        ref.start();
      }
      return () => {
        ref.stop();
        const idx = tasks.indexOf(entry);
        if (idx >= 0) tasks.splice(idx, 1);
      };
    },

    start() {
      if (heartbeat) return;
      heartbeat = createHeartbeat({
        intervalMs: globalInterval,
        onTick: () => {
          // 已经用 per-task heartbeat 跑, 这个 global 是 no-op (保留供扩展)
        },
      });
      heartbeat.start();
      // 同时启动所有 enabled 的 task
      for (const t of tasks) {
        if (t.opts.enabled !== false) t.ref.start();
      }
    },

    stop() {
      if (heartbeat) {
        heartbeat.stop();
        heartbeat = null;
      }
      for (const t of tasks) t.ref.stop();
    },

    async runOnce() {
      for (const t of tasks) {
        if (t.opts.enabled === false) continue;
        await t.ref.forceTick();
      }
    },

    get taskCount() {
      return tasks.length;
    },
    get running() {
      return heartbeat?.running ?? false;
    },
  };
}
