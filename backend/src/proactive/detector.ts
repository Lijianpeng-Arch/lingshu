/**
 * proactive/detector — proactive push / summary generation
 *
 * Spec 2D — persistent main loop (Phase E)
 *
 * Borrowed from:
 *   - macOS Notification Center (重要事件推送)
 *   - 白龙马 `proactive.py` (事件检测 → 主动告知)
 *   - ChatGPT Memory proactive notifications (主动汇报)
 *
 * 设计:
 *   - pure helpers (`detectReminderDue`, `detectErrorEvent`, `detectTaskCompletion`):
 *     给定数据, 返回建议信号 (或 null)
 *   - service (`createProactiveDetector`): 包装 reminderSvc + broadcast, 把信号转为 awareness.update
 *     事件 (kind = 'proactive.*')
 *
 *   注意: 真正的 checkDueReminders 定时调用交给 main-loop (整合到 main loop 后)
 */

import { newId } from '../util/id.js';
import type { UACSEnvelope } from '../uacs/envelope.js';
import type { ReminderService, Reminder } from './reminder.js';

// ──────── Signal types ────────

export type ProactiveSignalKind = 'reminder' | 'error' | 'task_completion' | 'insight';

export type ProactiveAction = 'push' | 'summary' | 'log';

export interface ProactiveSignal {
  kind: ProactiveSignalKind;
  action: ProactiveAction;
  data: Record<string, unknown>;
}

export interface ProactiveDetectorDeps {
  broadcast: (env: UACSEnvelope) => void;
  /** reminderSvc 是可选依赖; 不传也能跑 (只看 errors / completions) */
  reminderSvc?: ReminderService;
  now?: () => number;
}

export interface ProactiveDetector {
  /** 检查所有 due reminders → 推送 proactive.reminder + 标记 fired */
  checkDueReminders(): number;
  /** 用户/系统报告错误 → 评估是否值得主动 push */
  reportError(event: Record<string, unknown>): void;
  /** Plan/Task 完成 → 触发 summary 推送 */
  reportTaskCompletion(event: Record<string, unknown>): void;
}

// ──────── Schedule-based detection (时间触发 + quiet hours) ────────

export interface SchedulePreferences {
  /** 0-23 — quiet hours 开始 (inclusive). 默认 22 */
  quietHoursStart?: number;
  /** 0-23 — quiet hours 结束 (exclusive). 默认 7 */
  quietHoursEnd?: number;
}

export interface ScheduleItem {
  /** "HH:MM" 24h format */
  time: string;
  /** 提醒消息 */
  message: string;
}

export interface ProactiveScheduleInput {
  now: Date;
  preferences?: SchedulePreferences;
  schedules: ScheduleItem[];
}

export interface ProactiveScheduleReminder {
  time: string;
  message: string;
  /** epoch ms */
  triggeredAt: number;
}

/**
 * Pure helper: 根据当前时间 + 用户偏好 + 日程表, 返回应该推送的提醒数组.
 *
 * 行为:
 *   - quiet hours 内的所有提醒直接丢弃 (返回 []).
 *   - quietHours 在 start > end 时按 "跨越午夜" 处理 (e.g. 22 → 7).
 *     例: start=22, end=7 → 22,23,0,1,...,6 都算 quiet.
 *   - quietHours 在 start < end 时按同一天处理 (e.g. 13 → 17).
 *   - quietHours 在 start === end 时视为未开启 (全天允许).
 *   - 现在时间按本地时区解析 (new Date().getHours()/getMinutes()).
 *   - schedules.time 是 "HH:MM" 24h 格式, 与当前小时/分钟精确匹配.
 */
export function detectProactive(input: ProactiveScheduleInput): ProactiveScheduleReminder[] {
  const { now, preferences, schedules } = input;
  const hour = now.getHours();
  const minute = now.getMinutes();

  // 1. Quiet hours 检查 (静默期 → 全部丢弃)
  const qhStart = preferences?.quietHoursStart ?? 22;
  const qhEnd = preferences?.quietHoursEnd ?? 7;
  if (isInQuietHours(hour, qhStart, qhEnd)) {
    return [];
  }

  // 2. 匹配日程表 (精确到分钟)
  const hhmm = `${pad2(hour)}:${pad2(minute)}`;
  const matches: ProactiveScheduleReminder[] = [];
  for (const s of schedules) {
    if (s.time === hhmm) {
      matches.push({
        time: s.time,
        message: s.message,
        triggeredAt: now.getTime(),
      });
    }
  }
  return matches;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 判断 hour 是否在 quiet hours 区间内.
 *  - start === end → 不在 quiet (全天允许)
 *  - start > end   → 跨越午夜 (e.g. 22→7 意为 hour ∈ {22,23,0,1,...,6})
 *  - start < end   → 同一天 (e.g. 13→17 意为 hour ∈ {13,14,15,16})
 * 边界: start 包含, end 排除 (符合 HH 区间常理).
 */
function isInQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false; // 全天允许
  if (start > end) {
    // 跨越午夜
    return hour >= start || hour < end;
  }
  // 同一天
  return hour >= start && hour < end;
}

// ──────── Pure helpers (可独立测试, 也方便上层无需 db 就能判定) ────────

const GIT_PUSH_FAIL_RE = /git\s+push.*?(rejected|denied|failed)/i;
const BUILD_FAIL_RE = /(build|compile|tsc).*?(fail|error)/i;

export function detectReminderDue(reminder: Reminder, now: number): ProactiveSignal | null {
  if (reminder.status !== 'pending') return null;
  if (reminder.triggerAt > now) return null;
  return {
    kind: 'reminder',
    action: 'push',
    data: {
      id: reminder.id,
      message: reminder.message,
      user_input: reminder.userInput,
      trigger_at: reminder.triggerAt,
    },
  };
}

export function detectErrorEvent(event: Record<string, unknown>): ProactiveSignal | null {
  // shell_result 失败 + 文本匹配
  if (event.kind === 'shell_result') {
    const exit = event.exitCode;
    const stderr = String(event.stderr ?? '');
    const stdout = String(event.stdout ?? '');
    if (exit !== 0) {
      const text = stderr + '\n' + stdout;
      if (GIT_PUSH_FAIL_RE.test(text)) {
        return { kind: 'error', action: 'push', data: { kind: 'git_push_fail', exit, stderr: stderr.slice(0, 500) } };
      }
      if (BUILD_FAIL_RE.test(text)) {
        return { kind: 'error', action: 'push', data: { kind: 'build_fail', exit, stderr: stderr.slice(0, 500) } };
      }
      // 其他 shell 失败
      return { kind: 'error', action: 'push', data: { kind: 'shell_fail', exit, stderr: stderr.slice(0, 500) } };
    }
    return null;
  }
  return null;
}

export function detectTaskCompletion(event: Record<string, unknown>): ProactiveSignal | null {
  // Spec 2C-1 awareness 事件名
  if (event.kind === 'plan.completed' || event.kind === 'goal.complete') {
    return {
      kind: 'task_completion',
      action: 'summary',
      data: {
        source: event.kind,
        plan_id: typeof event.plan_id === 'string' ? event.plan_id : undefined,
        goal_id: typeof event.goalId === 'string' ? event.goalId : undefined,
        duration_ms: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
      },
    };
  }
  return null;
}

// ──────── Service ────────

function buildProactiveEnvelope(event: ProactiveSignal): UACSEnvelope {
  return {
    id: newId('awareness'),
    type: 'awareness.update',
    sender: 'soul',
    recipient: 'electron',
    timestamp: Date.now(),
    correlationId: null,
    traceMeta: {},
    payload: {
      kind: `proactive.${event.kind}`,
      action: event.action,
      data: event.data,
    },
  } as unknown as UACSEnvelope;
}

export function createProactiveDetector(deps: ProactiveDetectorDeps): ProactiveDetector {
  const now = deps.now ?? (() => Date.now());
  const broadcast = deps.broadcast;

  return {
    checkDueReminders() {
      const reminderSvc = deps.reminderSvc;
      if (!reminderSvc) return 0;
      const due = reminderSvc.listDue(now());
      let pushed = 0;
      for (const r of due) {
        const sig = detectReminderDue(r, now());
        if (sig) {
          broadcast(buildProactiveEnvelope(sig));
          reminderSvc.fire(r.id);
          pushed += 1;
        }
      }
      return pushed;
    },

    reportError(event) {
      const sig = detectErrorEvent(event);
      if (sig) broadcast(buildProactiveEnvelope(sig));
    },

    reportTaskCompletion(event) {
      const sig = detectTaskCompletion(event);
      if (sig) broadcast(buildProactiveEnvelope(sig));
    },
  };
}
