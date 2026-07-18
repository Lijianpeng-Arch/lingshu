import { describe, it, expect, vi } from 'vitest';
import {
  createProactiveDetector,
  detectErrorEvent,
  detectTaskCompletion,
  detectReminderDue,
  type ProactiveDetector,
  type ProactiveDetectorDeps,
} from './detector.js';

function makeDeps(overrides: Partial<ProactiveDetectorDeps> = {}): {
  deps: ProactiveDetectorDeps;
  broadcasted: Array<{ kind: string; [k: string]: unknown }>;
} {
  const broadcasted: Array<{ kind: string; [k: string]: unknown }> = [];
  const deps: ProactiveDetectorDeps = {
    broadcast: (env) => {
      const p = env.payload as { kind?: string; [k: string]: unknown };
      if (p && typeof p.kind === 'string') {
        broadcasted.push(p as { kind: string; [k: string]: unknown });
      }
    },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { deps, broadcasted };
}

describe('proactive/detector — pure helpers', () => {
  it('detectReminderDue: 当 reminder trigger_at 已过且未 fired → 返回建议推送', () => {
    const now = 1_700_000_000_000;
    const r = {
      id: 'r1',
      userInput: '明天 9 点提醒我开会',
      message: '开会',
      triggerAt: now - 5000,
      status: 'pending' as const,
      createdAt: now - 10000,
    };
    const signal = detectReminderDue(r, now);
    expect(signal).not.toBeNull();
    expect(signal!.kind).toBe('reminder');
    expect(signal!.action).toBe('push');
    expect((signal!.data as { id: string }).id).toBe('r1');
  });

  it('detectReminderDue: trigger_at 还没到 → 不推送', () => {
    const now = 1_700_000_000_000;
    const r = {
      id: 'r1',
      userInput: 'x',
      message: 'x',
      triggerAt: now + 60_000,
      status: 'pending' as const,
      createdAt: now,
    };
    expect(detectReminderDue(r, now)).toBeNull();
  });

  it('detectErrorEvent: 匹配 git push fail 模式', () => {
    const sig = detectErrorEvent({ kind: 'shell_result', exitCode: 1, stderr: 'git push failed to origin/main: rejected' });
    expect(sig).not.toBeNull();
    expect(sig?.kind).toBe('error');
    expect(sig?.action).toBe('push');
    expect((sig!.data as { kind: string }).kind).toBe('git_push_fail');
  });

  it('detectErrorEvent: exitCode 0 → 不推送', () => {
    expect(detectErrorEvent({ kind: 'shell_result', exitCode: 0, stderr: '' })).toBeNull();
  });

  it('detectErrorEvent: 非错误类型 → 不推送', () => {
    expect(detectErrorEvent({ kind: 'note', content: 'hi' })).toBeNull();
  });

  it('detectTaskCompletion: 长任务完成 → 推荐汇报', () => {
    const sig = detectTaskCompletion({ kind: 'plan.completed', plan_id: 'p1', duration_ms: 1234 });
    expect(sig).not.toBeNull();
    expect(sig?.kind).toBe('task_completion');
    expect(sig?.action).toBe('summary');
  });

  it('detectTaskCompletion: 失败 → 不汇报 (走 error 路径)', () => {
    const sig = detectTaskCompletion({ kind: 'plan.aborted', plan_id: 'p1' });
    expect(sig).toBeNull();
  });
});

describe('proactive/detector — service', () => {
  it('checkDueReminders(): 找出已过期 reminders 并广播 proactive.reminder + 标记 fired', () => {
    const now = 1_700_000_000_000;
    const listDue = vi.fn((at: number) => {
      if (at === now) {
        return [{ id: 'r1', userInput: '明天 9 点提醒我开会', message: '开会', triggerAt: now - 1, status: 'pending' as const, createdAt: now - 100 }];
      }
      return [];
    });
    const fire = vi.fn((id: string) => ({ id, status: 'fired' as const }));
    const { deps, broadcasted } = makeDeps({ now: () => now });
    const detector: ProactiveDetector = createProactiveDetector({
      ...deps,
      reminderSvc: {
        add: vi.fn(),
        get: vi.fn(() => null),
        list: vi.fn(() => []),
        listAll: vi.fn(() => []),
        listDue: listDue as unknown as NonNullable<ProactiveDetectorDeps['reminderSvc']>['listDue'],
        fire: fire as unknown as NonNullable<ProactiveDetectorDeps['reminderSvc']>['fire'],
        cancel: vi.fn(),
        delete: vi.fn(),
        nextReminderMs: vi.fn(() => undefined),
        addFromText: vi.fn(),
      },
    });

    const fired = detector.checkDueReminders();
    expect(fired).toBe(1);
    expect(fire).toHaveBeenCalledWith('r1');
    const reminderEv = broadcasted.find((e) => e.kind === 'proactive.reminder');
    expect(reminderEv).toBeDefined();
    expect((reminderEv?.data as { id: string }).id).toBe('r1');
  });

  it('checkDueReminders(): 没有过期 → 不广播', () => {
    const { deps, broadcasted } = makeDeps();
    const detector = createProactiveDetector({
      ...deps,
      reminderSvc: {
        add: vi.fn(),
        get: vi.fn(() => null),
        list: vi.fn(() => []),
        listAll: vi.fn(() => []),
        listDue: vi.fn(() => []),
        fire: vi.fn(),
        cancel: vi.fn(),
        delete: vi.fn(),
        nextReminderMs: vi.fn(() => undefined),
        addFromText: vi.fn(),
      },
    });
    const fired = detector.checkDueReminders();
    expect(fired).toBe(0);
    expect(broadcasted).toEqual([]);
  });

  it('reportError(): 真实错误 → 主动 push', () => {
    const { deps, broadcasted } = makeDeps();
    const detector = createProactiveDetector(deps);
    detector.reportError({ kind: 'shell_result', exitCode: 1, stderr: 'fatal: not a git repository' });
    const err = broadcasted.find((e) => e.kind === 'proactive.error');
    expect(err).toBeDefined();
    expect((err!.data as { kind: string }).kind).toBe('shell_fail');
  });

  it('reportError(): 不应该推送的 → 不广播 (silent drop)', () => {
    const { deps, broadcasted } = makeDeps();
    const detector = createProactiveDetector(deps);
    detector.reportError({ kind: 'note', content: 'ok' });
    expect(broadcasted).toEqual([]);
  });

  it('reportTaskCompletion(): plan.completed → summary push', () => {
    const { deps, broadcasted } = makeDeps();
    const detector = createProactiveDetector(deps);
    detector.reportTaskCompletion({ kind: 'plan.completed', plan_id: 'p1', duration_ms: 1000 });
    const ev = broadcasted.find((e) => e.kind === 'proactive.task_completion');
    expect(ev).toBeDefined();
  });
});
