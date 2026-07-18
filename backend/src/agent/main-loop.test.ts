import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createMainLoop, type MainLoop } from './main-loop.js';
import type { MainLoopDeps } from './main-loop.js';
import type { UACSEnvelope } from '../uacs/envelope.js';
import type { ToolDefinition } from '../tools/registry.js';
import type { AgentContext } from './goal.js';
import type { LLMProvider, VerdictResult } from './verifier.js';
import type { Goal } from './goal.js';
import { parseGoal } from './goal.js';
import type { Settings } from '../permission/settings.js';
import type { AwarenessEvent } from './awareness.js';
import { createSqlite } from '../db/sqlite.js';

function makeDeps(overrides: Partial<MainLoopDeps> = {}): { deps: MainLoopDeps; broadcasted: UACSEnvelope[] } {
  // Spec 2C-1: use real createSqlite so plan/plan_steps tables exist
  // for createPlanStore called from createMainLoop.
  const dir = mkdtempSync(join(tmpdir(), 'lingshu-ml-'));
  const dbPath = join(dir, 'ml.sqlite');
  const db = createSqlite(dbPath);
  const broadcasted: UACSEnvelope[] = [];
  const deps: MainLoopDeps = {
    db,
    broadcast: (env) => { broadcasted.push(env); },
    hasPendingUserMessage: () => false,
    hasActiveTask: () => false,
    isRateLimited: () => false,
    awakeningTicks: () => 99,
    reminderDueMs: () => undefined,
    startedAtMs: Date.now() - 1000,
    ...overrides,
  };
  return { deps, broadcasted };
}

describe('createMainLoop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts without ticking until the first interval fires', () => {
    const { deps, broadcasted } = makeDeps();
    const loop: MainLoop = createMainLoop(deps);
    loop.start();
    expect(loop.getState().tickCount).toBe(0);
    expect(broadcasted).toHaveLength(0);
    loop.stop();
  });

  it('triggerUserMessage fires an immediate tick that broadcasts a snapshot', async () => {
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    loop.start();
    await loop.triggerUserMessage();
    expect(loop.getState().tickCount).toBe(1);
    expect(broadcasted).toHaveLength(1);
    expect(broadcasted[0]?.type).toBe('awareness.snapshot');
    expect((broadcasted[0]?.payload as { status: { mode: string } } | undefined)?.status?.mode).toBe('idle');
    loop.stop();
  });

  it('stop() prevents further ticks', async () => {
    const { deps, broadcasted } = makeDeps({ awakeningTicks: () => 0 });
    const loop = createMainLoop(deps);
    loop.start();
    await loop.triggerUserMessage();
    loop.stop();
    vi.advanceTimersByTime(120_000);
    expect(loop.getState().tickCount).toBe(1);
    expect(broadcasted).toHaveLength(1);
  });

  it('reports reason=active_task when hasActiveTask is true', () => {
    const { deps } = makeDeps({ hasActiveTask: () => true });
    const loop = createMainLoop(deps);
    const state = loop.getState();
    expect(state.reason).toBe('active_task');
    loop.stop();
  });

  it('reports reason=user_message when hasPendingUserMessage is true', () => {
    const { deps } = makeDeps({ hasPendingUserMessage: () => true });
    const loop = createMainLoop(deps);
    const state = loop.getState();
    expect(state.reason).toBe('user_message');
    loop.stop();
  });
});

// ──────────────────────────────────────────────────────────────────
// Task 6: gateToolCall — Permission Gate 接入主循环
// ──────────────────────────────────────────────────────────────────

/**
 * Test seam: override loadSettings so tests don't touch the real ~/.lingshu/settings.json.
 * Each test installs its own vi.mock before the import. Since loadSettings is exported
 * via a module that we mock here, we use vi.mock at the top of the describe block.
 */
const mockSettingsState: { current: Settings } = { current: { mode: 'smart', rules: [], permissionTimeoutSeconds: 60 } };

vi.mock('../permission/settings.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../permission/settings.js')>();
  return {
    ...mod,
    loadSettings: () => mockSettingsState.current,
    saveSettings: (s: Settings) => { mockSettingsState.current = s; },
  };
});

const fakeTool: ToolDefinition = {
  name: 'delete_file',
  description: 'delete',
  displayName: '删除文件',
  displayDescription: '删除指定文件',
  parameters: {},
  risk: 'medium',
  execute: async () => ({ ok: true }),
};

describe('createMainLoop — gateToolCall (Task 6)', () => {
  beforeEach(() => {
    mockSettingsState.current = { mode: 'smart', rules: [], permissionTimeoutSeconds: 60 };
  });
  afterEach(() => vi.useRealTimers());

  it('deny: short-circuits and emits nothing to broadcast (no permission.request)', async () => {
    mockSettingsState.current = {
      mode: 'autonomous',
      rules: [{ permission: 'delete_file', pattern: '**', action: 'deny' }],
    };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const result = await loop.gateToolCall(fakeTool, { path: '/tmp/x' });
    expect(result.kind).toBe('deny');
    // No permission.request emitted — gate blocked it without asking
    expect(broadcasted.some(e => {
      const p = e.payload as any;
      return p && typeof p === 'object' && 'kind' in p && (p as AwarenessEvent).kind === 'permission.request';
    })).toBe(false);
    loop.stop();
  });

  it('allow (low risk + smart mode): passes through, no awareness event', async () => {
    mockSettingsState.current = { mode: 'smart', rules: [], permissionTimeoutSeconds: 60 };
    const lowRisk: ToolDefinition = { ...fakeTool, name: 'read_file', risk: 'low' };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const result = await loop.gateToolCall(lowRisk, { path: '/tmp/x' });
    expect(result.kind).toBe('allow');
    expect(broadcasted).toHaveLength(0);
    loop.stop();
  });

  it('ask: emits permission.request event with reason', async () => {
    mockSettingsState.current = { mode: 'smart', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    // Don't await — we want to verify the event was emitted synchronously before ask resolves
    const promise = loop.gateToolCall(fakeTool, { path: '/tmp/x' });
    // Give microtask a chance to run so permission.request envelope was broadcast
    await new Promise(resolve => setImmediate(resolve));
    const reqEnv = broadcasted.find(e => {
      const p = e.payload as any;
      return p && typeof p === 'object' && 'kind' in p && (p as AwarenessEvent).kind === 'permission.request';
    });
    expect(reqEnv).toBeDefined();
    const reqPayload = reqEnv!.payload as unknown as { kind: 'permission.request'; tool: string; reason: string };
    expect(reqPayload.tool).toBe('delete_file');
    expect(reqPayload.reason).toContain('删除文件');
    // Resolve the pending ask to clean up timers
    loop.resolvePermission(reqEnv!.id, 'allow');
    await promise;
    loop.stop();
  });

  it('ask → user allow: emits permission.resolved(allow)', async () => {
    mockSettingsState.current = { mode: 'smart', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const promise = loop.gateToolCall(fakeTool, { path: '/tmp/x' });
    await new Promise(resolve => setImmediate(resolve));
    const reqEnv = broadcasted.find(e => (e.payload as any)?.kind === 'permission.request')!;
    loop.resolvePermission(reqEnv.id, 'allow');
    const result = await promise;
    expect(result.kind).toBe('allow');
    const resolved = broadcasted.find(e => (e.payload as any)?.kind === 'permission.resolved');
    expect(resolved).toBeDefined();
    expect((resolved!.payload as any).decision).toBe('allow');
    loop.stop();
  });

  it('ask → user deny: emits permission.resolved(deny) and blocks tool', async () => {
    mockSettingsState.current = { mode: 'smart', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const promise = loop.gateToolCall(fakeTool, { path: '/tmp/x' });
    await new Promise(resolve => setImmediate(resolve));
    const reqEnv = broadcasted.find(e => (e.payload as any)?.kind === 'permission.request')!;
    loop.resolvePermission(reqEnv.id, 'deny');
    const result = await promise;
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.reason).toContain('user');
    }
    const resolved = broadcasted.find(e => (e.payload as any)?.kind === 'permission.resolved');
    expect((resolved!.payload as any).decision).toBe('deny');
    loop.stop();
  });

  it('ask → timeout (60s default): emits permission.timeout and denies', async () => {
    vi.useFakeTimers();
    mockSettingsState.current = { mode: 'smart', rules: [], permissionTimeoutSeconds: 1 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const promise = loop.gateToolCall(fakeTool, { path: '/tmp/x' });
    // Drain microtasks so permission.request is broadcast
    await vi.advanceTimersByTimeAsync(0);
    // Advance past timeout
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.reason).toContain('timeout');
    }
    const timeout = broadcasted.find(e => (e.payload as any)?.kind === 'permission.timeout');
    expect(timeout).toBeDefined();
    expect((timeout!.payload as any).tool).toBe('delete_file');
    loop.stop();
  });

  it('stop() denies and resolves pending permission requests', async () => {
    mockSettingsState.current = { mode: 'smart', rules: [], permissionTimeoutSeconds: 60 };
    const { deps } = makeDeps();
    const loop = createMainLoop(deps);
    const pending = loop.gateToolCall(fakeTool, { path: '/tmp/x' });
    await new Promise(resolve => setImmediate(resolve));

    loop.stop();

    await expect(pending).resolves.toEqual({ kind: 'deny', reason: 'stopped' });
  });

  it('ask → resolvePermission with unknown id: silently ignores (no crash)', async () => {
    const { deps } = makeDeps();
    const loop = createMainLoop(deps);
    expect(() => loop.resolvePermission('nonexistent', 'allow')).not.toThrow();
    loop.stop();
  });
});

// ──────────────────────────────────────────────────────────────────
// Task 6: runGoalMode — 目标模式入口 + verifier 异常降级
// ──────────────────────────────────────────────────────────────────

function makeMockContext(opts: { abortAfter?: number; summaries?: string[] } = {}): AgentContext & {
  askUserContinueMock: ReturnType<typeof vi.fn>;
  runOnceMock: ReturnType<typeof vi.fn>;
  isAbortedMock: ReturnType<typeof vi.fn>;
} {
  const summaries = opts.summaries ?? ['first summary'];
  let callIndex = 0;
  let callCount = 0;
  const runOnceMock = vi.fn(async (_g: Goal) => {
    const idx = callIndex;
    callCount++;
    return summaries[idx % summaries.length] ?? 'fallback';
  });
  const isAbortedMock = vi.fn(() => {
    if (opts.abortAfter === undefined) return false;
    return callCount > opts.abortAfter;
  });
  const askUserContinueMock = vi.fn(async (_msg: string) => undefined);
  return {
    runOnce: runOnceMock,
    isAborted: isAbortedMock,
    askUserContinue: askUserContinueMock,
    askUserContinueMock,
    runOnceMock,
    isAbortedMock,
  };
}

function makeMockLLM(verdicts: Array<{ results: VerdictResult[] } | 'parse-error' | 'all-pass' | 'all-fail'>): LLMProvider {
  let idx = 0;
  return {
    complete: vi.fn(async () => {
      const v = verdicts[idx % verdicts.length];
      idx++;
      if (v === 'parse-error') return { text: '<<<not json>>>' };
      if (v === 'all-pass') return { text: JSON.stringify({ results: [{ criterion: 'x', passed: true, evidence: 'ok' }] }) };
      if (v === 'all-fail') return { text: JSON.stringify({ results: [{ criterion: 'x', passed: false, evidence: 'no' }] }) };
      return { text: JSON.stringify(v) };
    }),
  };
}

describe('createMainLoop — runGoalMode (Task 6)', () => {
  beforeEach(() => {
    mockSettingsState.current = { mode: 'goal', rules: [], permissionTimeoutSeconds: 60 };
  });

  it('detects 目标: prefix and routes through runGoalLoop', async () => {
    mockSettingsState.current = { mode: 'goal', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext({ summaries: ['first summary'] });
    const llm = makeMockLLM(['all-pass']);
    const final = await loop.runGoalMode(
      '目标: 把仓库扫一遍\n验收:\n1) 列出来',
      ctx,
      llm,
    );
    expect(final).not.toBeNull();
    if (!final) return;
    expect(final.status).toBe('complete');
    // Broadcast goal.started + goal.complete events
    const started = broadcasted.find(e => (e.payload as any)?.kind === 'goal.started');
    expect(started).toBeDefined();
    expect((started!.payload as any).statement).toContain('把仓库扫一遍');
    const completed = broadcasted.find(e => (e.payload as any)?.kind === 'goal.complete');
    expect(completed).toBeDefined();
    loop.stop();
  });

  it('does NOT route to goal mode when mode != goal (even with 目标: prefix)', async () => {
    mockSettingsState.current = { mode: 'smart', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext();
    const llm = makeMockLLM(['all-pass']);
    const result = await loop.runGoalMode(
      '目标: 任何目标\n验收:\n1) x',
      ctx,
      llm,
    );
    // Should return null = "no goal routing happened"
    expect(result).toBeNull();
    expect(broadcasted.some(e => (e.payload as any)?.kind === 'goal.started')).toBe(false);
    loop.stop();
  });

  it('does NOT route when 目标: prefix is absent (even in goal mode)', async () => {
    mockSettingsState.current = { mode: 'goal', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext();
    const llm = makeMockLLM(['all-pass']);
    const result = await loop.runGoalMode('普通的聊天消息', ctx, llm);
    expect(result).toBeNull();
    expect(broadcasted.some(e => (e.payload as any)?.kind === 'goal.started')).toBe(false);
    loop.stop();
  });

  it('emits goal.iteration on each step', async () => {
    mockSettingsState.current = { mode: 'goal', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext({ summaries: ['s1', 's2', 's3'] });
    const llm = makeMockLLM([
      { results: [{ criterion: 'x', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'x', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'x', passed: true, evidence: 'ok' }] },
    ]);
    const final = await loop.runGoalMode(
      '目标: 跑 3 步\n验收:\n1) x',
      ctx,
      llm,
    );
    expect(final).not.toBeNull();
    if (!final) return;
    expect(final.status).toBe('complete');
    expect(final.iterations).toBe(3);
    const iterEvents = broadcasted.filter(e => (e.payload as any)?.kind === 'goal.iteration');
    expect(iterEvents).toHaveLength(3);
    expect((iterEvents[0].payload as any).iter).toBe(1);
    expect((iterEvents[2].payload as any).iter).toBe(3);
    loop.stop();
  });

  it('emits goal.aborted when user aborts (isAborted=true)', async () => {
    mockSettingsState.current = { mode: 'goal', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext({ abortAfter: 2, summaries: ['s1', 's2', 's3', 's4'] });
    const llm = makeMockLLM([{ results: [{ criterion: 'x', passed: false, evidence: 'no' }] }]);
    const final = await loop.runGoalMode(
      '目标: 测试中断\n验收:\n1) x',
      ctx,
      llm,
    );
    expect(final).not.toBeNull();
    if (!final) return;
    expect(final.status).toBe('aborted');
    const aborted = broadcasted.find(e => (e.payload as any)?.kind === 'goal.aborted');
    expect(aborted).toBeDefined();
    loop.stop();
  });

  it('verifier parse error → does NOT abort goal; continues iterating (降级)', async () => {
    // Spec 2A I2: try/catch moved into goal.ts runGoalLoop — main-loop no longer wraps it.
    // main-loop test now verifies the chain still surfaces the error gracefully.
    mockSettingsState.current = { mode: 'goal', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext({ summaries: ['s1', 's2'] });
    const llm = makeMockLLM([
      'parse-error',         // iter 1: verifier JSON parse fails → caught inside goal.ts, continues
      'all-pass',            // iter 2: verifier returns allPass → complete
    ]);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const final = await loop.runGoalMode(
      '目标: verifier 异常测试\n验收:\n1) x',
      ctx,
      llm,
    );
    expect(final).not.toBeNull();
    if (!final) return;
    expect(final.status).toBe('complete');
    expect(final.iterations).toBe(2);
    // Verifier failure logged from inside goal.ts (new try/catch location)
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[goal] verifier error'),
      expect.anything(),
    );
    consoleErrSpy.mockRestore();
    loop.stop();
  });
});

// ──────────────────────────────────────────────────────────────────
// Spec 2C-1: runPlanMode — Plan mode entry + awareness events
// ──────────────────────────────────────────────────────────────────

/**
 * Plan-mode LLM mock: returns a valid 3-step plan.
 * 借 planner/index.ts 期望的 schema.
 */
function makePlanModeLLM(text: string): LLMProvider {
  return {
    complete: vi.fn(async () => ({ text })),
  };
}

describe('createMainLoop — runPlanMode (Spec 2C-1)', () => {
  beforeEach(() => {
    mockSettingsState.current = { mode: 'plan', rules: [], permissionTimeoutSeconds: 60 };
  });

  it('detects 目标: prefix in plan mode + LLM planner → emits plan.created + plan.completed', async () => {
    mockSettingsState.current = { mode: 'plan', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext({ summaries: ['r1', 'r2', 'r3'] });
    const llm = makePlanModeLLM(JSON.stringify({
      steps: [
        { description: 'step-A' },
        { description: 'step-B' },
        { description: 'step-C' },
      ],
    }));

    const final = await loop.runPlanMode(
      '目标: 修好 login\n验收:\n1) 测试全过',
      ctx,
      llm,
    );

    expect(final).not.toBeNull();
    if (!final) return;
    expect(final.status).toBe('completed');
    expect(final.steps).toHaveLength(3);

    // plan.created
    const created = broadcasted.find(e => (e.payload as any)?.kind === 'plan.created');
    expect(created).toBeDefined();
    expect((created!.payload as any).plan.steps).toHaveLength(3);

    // plan.step_started × 3, plan.step_completed × 3
    expect(broadcasted.filter(e => (e.payload as any)?.kind === 'plan.step_started')).toHaveLength(3);
    expect(broadcasted.filter(e => (e.payload as any)?.kind === 'plan.step_completed')).toHaveLength(3);

    // plan.completed
    const completed = broadcasted.find(e => (e.payload as any)?.kind === 'plan.completed');
    expect(completed).toBeDefined();
    expect((completed!.payload as any).duration_ms).toBeGreaterThanOrEqual(0);
    loop.stop();
  });

  it('does NOT route when settings.mode !== plan', async () => {
    mockSettingsState.current = { mode: 'goal', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext();
    const llm = makePlanModeLLM(JSON.stringify({ steps: [{ description: 'a' }, { description: 'b' }, { description: 'c' }] }));

    const final = await loop.runPlanMode('目标: foo\n验收:\n1) x', ctx, llm);
    expect(final).toBeNull();
    expect(broadcasted.some(e => (e.payload as any)?.kind === 'plan.created')).toBe(false);
    loop.stop();
  });

  it('does NOT route when input lacks 目标: prefix', async () => {
    mockSettingsState.current = { mode: 'plan', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext();
    const llm = makePlanModeLLM('{}');

    const final = await loop.runPlanMode('普通聊天消息', ctx, llm);
    expect(final).toBeNull();
    expect(broadcasted.some(e => (e.payload as any)?.kind === 'plan.created')).toBe(false);
    loop.stop();
  });

  it('falls back to parsePlanFromGoal when LLM planner fails', async () => {
    mockSettingsState.current = { mode: 'plan', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext({ summaries: ['r1'] });
    // LLM returns non-JSON → planner throws → fallback to parser
    const llm = makePlanModeLLM('this is not json');

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const final = await loop.runPlanMode(
      '目标: simple\n验收:\n1) a\n2) b\n3) c',  // 3 acceptance → parser 拆 3 步
      ctx,
      llm,
    );

    expect(final).not.toBeNull();
    if (!final) return;
    expect(final.status).toBe('completed');
    expect(final.steps).toHaveLength(3);  // parser 1 acceptance → 1 step

    // plan.created 仍然被发出
    const created = broadcasted.find(e => (e.payload as any)?.kind === 'plan.created');
    expect(created).toBeDefined();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[plan-mode]'),
      expect.anything(),
    );
    consoleWarnSpy.mockRestore();
    loop.stop();
  });

  it('persists plan to SQLite via planRepo', async () => {
    mockSettingsState.current = { mode: 'plan', rules: [], permissionTimeoutSeconds: 60 };
    const { deps } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext({ summaries: ['r1', 'r2', 'r3'] });
    const llm = makePlanModeLLM(JSON.stringify({
      steps: [{ description: 'a' }, { description: 'b' }, { description: 'c' }],
    }));

    const final = await loop.runPlanMode(
      '目标: persist test\n验收:\n1) a',
      ctx,
      llm,
    );
    expect(final).not.toBeNull();
    if (!final) return;

    // 从 sqlite 里重新读出来
    const repo = loop.getPlanRepo();
    const loaded = repo.getPlan(final.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('completed');
    expect(loaded!.steps).toHaveLength(3);
    loop.stop();
  });

  it('resumePlan: null for nonexistent plan_id', async () => {
    mockSettingsState.current = { mode: 'plan', rules: [], permissionTimeoutSeconds: 60 };
    const { deps } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext();
    const llm = makePlanModeLLM('{}');

    const resumed = await loop.resumePlan('nonexistent', ctx, llm);
    expect(resumed).toBeNull();
    loop.stop();
  });

  it('resumePlan: returns completed plan as-is (no re-run)', async () => {
    mockSettingsState.current = { mode: 'plan', rules: [], permissionTimeoutSeconds: 60 };
    const { deps } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext();
    const llm = makePlanModeLLM('{}');

    // 先建一个已完成的 plan
    const repo = loop.getPlanRepo();
    const now = Date.now();
    const completedPlan = repo.createPlan({
      id: 'pre-completed', goal_id: 'g1', status: 'completed', current_step_index: 0,
      replan_count: 0, created_at: now, updated_at: now,
      steps: [{ id: 's1', description: 'A', status: 'completed', retries: 0, result: 'r' }],
    });

    const resumed = await loop.resumePlan(completedPlan.id, ctx, llm);
    expect(resumed).not.toBeNull();
    expect(resumed!.status).toBe('completed');
    expect(ctx.runOnceMock).not.toHaveBeenCalled();
    loop.stop();
  });

  it('resumePlan: resumes an incomplete plan (persisted running→pending)', async () => {
    mockSettingsState.current = { mode: 'plan', rules: [], permissionTimeoutSeconds: 60 };
    const { deps, broadcasted } = makeDeps();
    const loop = createMainLoop(deps);
    const ctx = makeMockContext({ summaries: ['r2', 'r3'] });
    const llm = makePlanModeLLM('{}');

    // 手动建一个 plan: s1 已完成, s2 running (模拟中断), s3 pending
    const repo = loop.getPlanRepo();
    const now = Date.now();
    repo.createPlan({
      id: 'resumable', goal_id: 'g1', status: 'running', current_step_index: 1,
      replan_count: 0, created_at: now, updated_at: now,
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0, result: 'r1' },
        { id: 's2', description: 'B', status: 'running', retries: 0, started_at: now },
        { id: 's3', description: 'C', status: 'pending', retries: 0 },
      ],
    });

    const resumed = await loop.resumePlan('resumable', ctx, llm);
    expect(resumed).not.toBeNull();
    if (!resumed) return;
    expect(resumed.status).toBe('completed');
    expect(resumed.steps[0].status).toBe('completed');
    expect(resumed.steps[1].status).toBe('completed');
    expect(resumed.steps[2].status).toBe('completed');

    // emit plan.step_started × 2 (s2, s3 — s1 skipped because already completed)
    const startEvents = broadcasted.filter(e => (e.payload as any)?.kind === 'plan.step_started');
    expect(startEvents).toHaveLength(2);
    loop.stop();
  });
});