import { describe, it, expect } from 'vitest';
import { detectProactive } from './detector.js';

describe('Proactive detector — 时间触发 + quiet hours', () => {
  it('detects time-based reminder', () => {
    const r = detectProactive({
      now: new Date('2026-07-16T08:00:00'),
      preferences: { quietHoursStart: 22, quietHoursEnd: 7 },
      schedules: [{ time: '08:00', message: '早上好,看天气吗' }],
    });
    expect(r.length).toBeGreaterThan(0);
  });

  it('suppresses during quiet hours', () => {
    const r = detectProactive({
      now: new Date('2026-07-16T23:00:00'),
      preferences: { quietHoursStart: 22, quietHoursEnd: 7 },
      schedules: [{ time: '23:00', message: '提醒' }],
    });
    expect(r.length).toBe(0);
  });

  it('suppresses during same-day quiet hours (start < end)', () => {
    const r = detectProactive({
      now: new Date('2026-07-16T14:00:00'),
      preferences: { quietHoursStart: 13, quietHoursEnd: 17 },
      schedules: [{ time: '14:00', message: '下午提醒' }],
    });
    expect(r.length).toBe(0);
  });

  it('fires during same-day quiet hours (before/after window)', () => {
    const r = detectProactive({
      now: new Date('2026-07-16T12:00:00'),
      preferences: { quietHoursStart: 13, quietHoursEnd: 17 },
      schedules: [{ time: '12:00', message: '午饭提醒' }],
    });
    expect(r.length).toBe(1);
    expect(r[0].message).toBe('午饭提醒');
  });
});
