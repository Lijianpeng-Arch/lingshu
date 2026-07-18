import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSqlite } from '../db/sqlite.js';
import {
  createReminderService,
  parseNaturalTime,
  parseReminderFromMessage,
  type ReminderService,
} from './reminder.js';

let db: Database.Database;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'lingshu-rem-'));
  db = createSqlite(join(dir, 'rem.sqlite'));
});

describe('proactive/reminder — parseNaturalTime', () => {
  const base = new Date('2026-07-16T10:30:00').getTime();

  it('明天 <time>: adds 1 day, sets time', () => {
    const result = parseNaturalTime('明天 9 点', base);
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // July = 6
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it('今天 <time>: sets time today (or tomorrow if in past)', () => {
    // 10:30 之前的 14:00 → 今天 14:00
    const r1 = parseNaturalTime('今天 14 点', base);
    expect(r1).not.toBeNull();
    const d1 = new Date(r1!);
    expect(d1.getDate()).toBe(16);
    expect(d1.getHours()).toBe(14);
    // 已过去的时间 → 跳到明天
    const r2 = parseNaturalTime('今天 9 点', base);
    const d2 = new Date(r2!);
    expect(d2.getDate()).toBe(17);
  });

  it('后天 <time>: adds 2 days', () => {
    const r = parseNaturalTime('后天 9 点', base);
    expect(r).not.toBeNull();
    const d = new Date(r!);
    expect(d.getDate()).toBe(18);
    expect(d.getHours()).toBe(9);
  });

  it('上午/下午: maps to 24h format', () => {
    expect(new Date(parseNaturalTime('明天上午9点', base)!).getHours()).toBe(9);
    expect(new Date(parseNaturalTime('明天下午3点', base)!).getHours()).toBe(15);
    expect(new Date(parseNaturalTime('明天晚上8点', base)!).getHours()).toBe(20);
  });

  it('In N minutes/hours: relative offset', () => {
    expect(parseNaturalTime('半小时后', base)).toBe(base + 30 * 60_000);
    expect(parseNaturalTime('2小时后', base)).toBe(base + 2 * 60 * 60_000);
    expect(parseNaturalTime('15分钟后', base)).toBe(base + 15 * 60_000);
  });

  it('明天 21:30 — explicit HH:MM form', () => {
    const r = parseNaturalTime('明天 21:30', base);
    expect(r).not.toBeNull();
    const d = new Date(r!);
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(21);
    expect(d.getMinutes()).toBe(30);
  });

  it('unparsable strings: returns null', () => {
    expect(parseNaturalTime('hello world', base)).toBeNull();
    expect(parseNaturalTime('', base)).toBeNull();
    expect(parseNaturalTime('随便聊聊', base)).toBeNull();
  });
});

describe('proactive/reminder — parseReminderFromMessage', () => {
  const base = new Date('2026-07-16T10:30:00').getTime();

  it('"提醒我明天9点开会" → message=开会, trigger=tomorrow 9:00', () => {
    const r = parseReminderFromMessage('提醒我明天9点开会', base);
    expect(r).not.toBeNull();
    expect(r!.message).toBe('开会');
    const d = new Date(r!.triggerAt);
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(9);
    expect(r!.userInput).toBe('提醒我明天9点开会');
  });

  it('"明天9点提醒我review" → message=review', () => {
    const r = parseReminderFromMessage('明天9点提醒我review', base);
    expect(r).not.toBeNull();
    expect(r!.message).toBe('review');
  });

  it('"提醒我 今晚 8 点 给妈妈打电话" → message=给妈妈打电话', () => {
    const r = parseReminderFromMessage('提醒我 今晚 8 点 给妈妈打电话', base);
    expect(r).not.toBeNull();
    expect(r!.message).toContain('给妈妈打电话');
  });

  it('non-reminder messages: returns null', () => {
    expect(parseReminderFromMessage('今天天气不错', base)).toBeNull();
    expect(parseReminderFromMessage('帮我写下计划', base)).toBeNull();
  });

  it('"remind me ..." (English) → returns null (Chinese only for v1)', () => {
    expect(parseReminderFromMessage('remind me tomorrow at 9 to call mom', base)).toBeNull();
  });
});

describe('proactive/reminder — service', () => {
  it('add: 持久化 + get 拿回', () => {
    const svc: ReminderService = createReminderService(db);
    const r = svc.add({
      userInput: '明天 9 点提醒我开会',
      message: '开会',
      triggerAt: Date.now() + 60_000,
    });
    expect(r.id).toBeTruthy();
    expect(r.status).toBe('pending');
    const got = svc.get(r.id);
    expect(got?.message).toBe('开会');
  });

  it('addFromText: 解析 + 持久化', () => {
    const svc = createReminderService(db);
    const r = svc.addFromText('提醒我明天9点review');
    expect(r).not.toBeNull();
    expect(r!.message).toBe('review');
  });

  it('addFromText: 无法解析 → 不写入, 返回 null', () => {
    const svc = createReminderService(db);
    const r = svc.addFromText('今天天气真好');
    expect(r).toBeNull();
    expect(svc.list().length).toBe(0);
  });

  it('listDue(now): 返回 trigger_at<=now 且 status=pending 的, 按时间升序', () => {
    const svc = createReminderService(db);
    const past = svc.add({ userInput: 'a', message: 'a', triggerAt: Date.now() - 5000 });
    const fut = svc.add({ userInput: 'b', message: 'b', triggerAt: Date.now() + 60_000 });
    const due = svc.listDue(Date.now());
    expect(due.map((d) => d.id)).toContain(past.id);
    expect(due.map((d) => d.id)).not.toContain(fut.id);
  });

  it('fire: pending → fired, 返回 fired reminder', () => {
    const svc = createReminderService(db);
    const r = svc.add({ userInput: 'a', message: 'a', triggerAt: Date.now() - 1000 });
    const fired = svc.fire(r.id);
    expect(fired?.status).toBe('fired');
  });

  it('fire: 不存在的 id → 返回 null', () => {
    const svc = createReminderService(db);
    expect(svc.fire('nonexistent')).toBeNull();
  });

  it('cancel: pending → cancelled', () => {
    const svc = createReminderService(db);
    const r = svc.add({ userInput: 'a', message: 'a', triggerAt: Date.now() + 60_000 });
    const cancelled = svc.cancel(r.id);
    expect(cancelled?.status).toBe('cancelled');
  });

  it('list (active only by default): 不含 cancelled/fired', () => {
    const svc = createReminderService(db);
    const r1 = svc.add({ userInput: 'a', message: 'a', triggerAt: Date.now() - 1000 });
    const r2 = svc.add({ userInput: 'b', message: 'b', triggerAt: Date.now() + 60_000 });
    svc.fire(r1.id);
    const active = svc.list();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(r2.id);
  });

  it('nextReminderMs(): 返回最近的 pending reminder 时刻, 或 undefined', () => {
    const svc = createReminderService(db);
    expect(svc.nextReminderMs()).toBeUndefined();
    const t1 = Date.now() + 60_000;
    svc.add({ userInput: 'a', message: 'a', triggerAt: t1 });
    const t2 = Date.now() + 30_000;
    svc.add({ userInput: 'b', message: 'b', triggerAt: t2 });
    expect(svc.nextReminderMs()).toBe(t2);
  });
});
