/**
 * proactive/reminder — natural-language reminder service
 *
 * Spec 2D — persistent main loop (Phase E)
 *
 * Borrowed from:
 *   - macOS Reminders DB schema (timestamp-indexed, status state machine)
 *   - Apple Reminders NL parser (chrono-node style, but stripped to zh-only for v1)
 *   - 白龙马 `reminder.py` (state machine: pending → fired/cancelled)
 *
 * 设计:
 *   - 自然语言时间解析 (中文优先, "明天9点" / "明天上午9点" / "半小时后")
 *   - 提醒 CRUD 全部落 SQLite
 *   - addFromText 是聊天入口 (匹配 chat-handler 中的 "提醒我...")
 *
 *   - DB 表是 user_reminders (避免与 migration v2 的 reminders 重名).
 *     API 层面保持 Reminder/ReminderStatus 概念统一.
 */

import type { Database as Db } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type ReminderStatus = 'pending' | 'fired' | 'cancelled';

export interface Reminder {
  id: string;
  userInput: string;
  message: string;
  triggerAt: number;
  status: ReminderStatus;
  createdAt: number;
}

export interface ReminderService {
  add(reminder: Omit<Reminder, 'id' | 'status' | 'createdAt'>): Reminder;
  get(id: string): Reminder | null;
  list(): Reminder[];                              // 默认只返回 pending
  listAll(): Reminder[];
  listDue(now: number): Reminder[];
  fire(id: string): Reminder | null;
  cancel(id: string): Reminder | null;
  delete(id: string): void;
  nextReminderMs(): number | undefined;
  /** 从自然语言文本解析 + add (chat-handler 入口) */
  addFromText(text: string, now?: number): Reminder | null;
}

// ──────── Natural-language time parsing ────────
// 中文优先, v1 不支持英文. 复用思路: chrono-node (有 npm 包但这版不引入).
// 模式覆盖: 明天/今天/后天, 上午/下午/晚上, HH:MM, N小时后, N分钟后.

interface ParsedTime {
  hours: number;
  minutes: number;
  /** 相对天数 (-1=昨天, 0=今天, 1=明天, 2=后天). 默认 1 (明天) 因为提示都是 "提醒我 X" */
  dayOffset: number;
  /** explicit YYYY-MM-DD (可选) */
  date?: { y: number; m: number; d: number };
}

const HOUR_NAMES: Array<{ re: RegExp; h: number }> = [
  { re: /上午|早上|凌晨/, h: 9 },     // 模糊默认 → 但优先显式 hour
  { re: /中午/, h: 12 },
  { re: /下午/, h: 15 },
  { re: /晚上|夜里/, h: 20 },
];

function getDayOffset(text: string): number {
  if (/后天/.test(text)) return 2;
  if (/明天|明日|明早|明晚/.test(text)) return 1;
  if (/今天|今晚|今早/.test(text)) return 0;
  // 默认: 隐含未来
  return 1;
}

function getHour(text: string): number | null {
  // HH:MM 格式优先 (e.g. "21:30")
  const colonMatch = text.match(/(\d{1,2}):(\d{2})/);
  if (colonMatch) {
    const h = parseInt(colonMatch[1], 10);
    const m = parseInt(colonMatch[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      // 即使后面有 下午, 默认原值 (用户写 14:30 大概率是 14:30)
      return h;
    }
  }

  // 显式 "<num>点"
  const hourMatch = text.match(/(\d{1,2})\s*点/);
  let baseHour: number | null = null;
  if (hourMatch) {
    baseHour = parseInt(hourMatch[1], 10);
  }

  // 修饰词: 下午 / 晚上 (12 + baseHour 时)
  let modifier = 0;
  if (/下午/.test(text)) {
    modifier = 12; // 下午 3 → 15
    if (baseHour !== null && baseHour < 12) baseHour = baseHour % 12;
  } else if (/晚上|夜里/.test(text)) {
    modifier = 12;
    if (baseHour !== null && baseHour < 12) baseHour = baseHour % 12;
  } else if (/上午|早上|凌晨/.test(text)) {
    // 上午 X 点 → X (0-11)
    if (baseHour !== null && baseHour === 12) baseHour = 0;
  } else if (/中午/.test(text)) {
    if (baseHour !== null && baseHour < 12) baseHour = baseHour + 12;
    else if (baseHour === null) baseHour = 12;
  }

  if (baseHour === null) {
    // 仅修饰词, 默认按修饰词
    for (const h of HOUR_NAMES) {
      if (h.re.test(text)) return h.h;
    }
    return null;
  }

  if (modifier > 0 && baseHour < 12) baseHour += modifier;
  // 12 下午特例: 下午 12 点 → 12
  return baseHour;
}

function getMinute(text: string, hourMatch: number | null): number {
  const colonMatch = text.match(/(\d{1,2}):(\d{2})/);
  if (colonMatch) return parseInt(colonMatch[2], 10);
  // "<num>点<num>分" 形式
  const minuteMatch = text.match(/点\s*(\d{1,2})\s*分?/);
  if (minuteMatch) {
    const m = parseInt(minuteMatch[1], 10);
    if (m >= 0 && m <= 59) return m;
  }
  // "<hour>点半" 形式
  if (/半/.test(text) && hourMatch !== null) return 30;
  return 0;
}

function parseRelative(text: string, base: number): number | null {
  // "<N> 分钟/分后"
  const minute = text.match(/(\d+)\s*分钟?后/);
  if (minute) {
    return base + parseInt(minute[1], 10) * 60_000;
  }
  // "<N> 小时/个钟头后"
  const hour = text.match(/(\d+)\s*(?:小时|个?钟头)后/);
  if (hour) {
    return base + parseInt(hour[1], 10) * 60 * 60_000;
  }
  // "半小时后"
  if (/半小时后/.test(text)) return base + 30 * 60_000;
  return null;
}

/**
 * 把自然语言时间 → timestamp (ms). 不可解析返回 null.
 * @param text 含时间描述的中文文本
 * @param base 当前时间 (用于"今天"相对判断 + 相对 offset)
 */
export function parseNaturalTime(text: string, base: number = Date.now()): number | null {
  // 1. 相对时间 (半小时后 / 2小时后)
  const rel = parseRelative(text, base);
  if (rel !== null) return rel;

  // 2. 解析小时 + 分钟 + 天偏移
  const dayOffset = getDayOffset(text);
  const hour = getHour(text);
  if (hour === null) return null;
  const minutes = getMinute(text, hour);

  const now = new Date(base);
  const target = new Date(base);
  target.setHours(hour, minutes, 0, 0);
  // 加 dayOffset 天 (本地时区)
  if (dayOffset !== 0) {
    target.setDate(target.getDate() + dayOffset);
  }
  // 如果是今天 (dayOffset=0) 且时间已过 → 推到明天
  if (dayOffset === 0 && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

// ──────── Reminder extraction from message ────────

/**
 * 从用户消息里识别"提醒我..."模式, 提取时间和内容.
 * 模式:
 *   - "提醒我 <time> <content>" → content 提取出来
 *   - "<time> 提醒我 <content>" → content 提取出来
 *  返回结构: { userInput, message, triggerAt } 或 null (无法解析)
 */
export function parseReminderFromMessage(
  text: string,
  base: number = Date.now(),
): { userInput: string; message: string; triggerAt: number } | null {
  // 1. 必须包含 "提醒" 或 "remind"
  if (!/提醒|remind/i.test(text)) return null;

  const triggerAt = parseNaturalTime(text, base);
  if (triggerAt === null) return null;

  // 2. 提取消息内容: 在 时间段 和 "提醒我" 之外的部分
  // 简化: 去掉 "提醒我" / 时间短语 / 修饰词, 剩下的就是 message
  let msg = text;
  msg = msg.replace(/^.*?提醒我/, '');     // 去掉前缀
  msg = msg.replace(/提醒我.*?(?=\d|$|.{0,5}(开|去|做|写|review|meeting|call))/, '');

  // 移除已知时间短语
  msg = msg.replace(/(今|明|后)天?\s*(上午|早上|中午|下午|晚上|凌晨|夜里)?\s*\d{1,2}(点|:\d{2})?(\s*\d{1,2}\s*分?)?/g, '');
  msg = msg.replace(/(上午|早上|中午|下午|晚上|凌晨|夜里|今晚|明晚|今早|明早)/g, '');
  msg = msg.replace(/\d+\s*(?:分钟?|小时|个?钟头)后/, '');
  msg = msg.replace(/半小时后/, '');
  msg = msg.replace(/\s+/g, ' ').trim();

  if (msg.length === 0) {
    // fallback: 整句话作为 message
    msg = text.replace(/提醒我|提醒|记得/, '').trim();
  }
  if (msg.length === 0) msg = '你设置了一个提醒';

  return {
    userInput: text.trim(),
    message: msg,
    triggerAt,
  };
}

// ──────── Service ────────

interface ReminderRow {
  id: string;
  user_input: string;
  message: string;
  trigger_at: number;
  status: string;
  created_at: number;
}

function rowToReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    userInput: row.user_input,
    message: row.message,
    triggerAt: row.trigger_at,
    status: row.status as ReminderStatus,
    createdAt: row.created_at,
  };
}

export function createReminderService(db: Db): ReminderService {
  const insertStmt = db.prepare(`INSERT INTO user_reminders
    (id, user_input, message, trigger_at, status, created_at)
    VALUES (@id, @user_input, @message, @trigger_at, @status, @created_at)`);
  const getStmt = db.prepare('SELECT * FROM user_reminders WHERE id = ?');
  const listPendingStmt = db.prepare(`SELECT * FROM user_reminders WHERE status='pending' ORDER BY trigger_at ASC`);
  const listAllStmt = db.prepare(`SELECT * FROM user_reminders ORDER BY trigger_at ASC`);
  const listDueStmt = db.prepare(`SELECT * FROM user_reminders WHERE status='pending' AND trigger_at <= ? ORDER BY trigger_at ASC`);
  const fireStmt = db.prepare(`UPDATE user_reminders SET status='fired' WHERE id=? AND status='pending'`);
  const cancelStmt = db.prepare(`UPDATE user_reminders SET status='cancelled' WHERE id=? AND status='pending'`);
  const deleteStmt = db.prepare('DELETE FROM user_reminders WHERE id = ?');
  const nextPendingStmt = db.prepare(`SELECT trigger_at FROM user_reminders WHERE status='pending' ORDER BY trigger_at ASC LIMIT 1`);

  return {
    add(reminder) {
      const now = Date.now();
      const id = randomUUID();
      insertStmt.run({
        id,
        user_input: reminder.userInput,
        message: reminder.message,
        trigger_at: reminder.triggerAt,
        status: 'pending',
        created_at: now,
      });
      const row = getStmt.get(id) as ReminderRow;
      return rowToReminder(row);
    },

    get(id) {
      const row = getStmt.get(id) as ReminderRow | undefined;
      return row ? rowToReminder(row) : null;
    },

    list() {
      const rows = listPendingStmt.all() as ReminderRow[];
      return rows.map(rowToReminder);
    },

    listAll() {
      const rows = listAllStmt.all() as ReminderRow[];
      return rows.map(rowToReminder);
    },

    listDue(now) {
      const rows = listDueStmt.all(now) as ReminderRow[];
      return rows.map(rowToReminder);
    },

    fire(id) {
      const result = fireStmt.run(id);
      if (result.changes === 0) return null;
      return this.get(id);
    },

    cancel(id) {
      const result = cancelStmt.run(id);
      if (result.changes === 0) return null;
      return this.get(id);
    },

    delete(id) {
      deleteStmt.run(id);
    },

    nextReminderMs() {
      const row = nextPendingStmt.get() as { trigger_at: number } | undefined;
      return row?.trigger_at;
    },

    addFromText(text, now) {
      const parsed = parseReminderFromMessage(text, now ?? Date.now());
      if (!parsed) return null;
      return this.add(parsed);
    },
  };
}
