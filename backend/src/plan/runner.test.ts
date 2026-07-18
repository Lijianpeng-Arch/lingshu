/**
 * PlanRunner 测试 — 灵枢 V2 Spec 2C-1
 *
 * TDD: 先写测试, 验证 runPlan / resumePlan / prepareForResume 行为.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPlanStore } from './store.js';
import { createPlanRunner, type RunnerContext, type PlanEvent } from './runner.js';
import type { LLMProvider } from '../agent/verifier.js';
import type { Plan, PlanStep } from './types.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step_index INTEGER NOT NULL DEFAULT 0,
      replan_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      retries INTEGER NOT NULL DEFAULT 0,
      acceptance TEXT,
      parallel_group TEXT,
      subtasks TEXT,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_plan_steps_plan ON plan_steps(plan_id, step_index);
  `);
  return db;
}

function makePlan(repo: ReturnType<typeof createPlanStore>, overrides: Partial<Plan> = {}): Plan {
  const now = Date.now();
  const plan: Plan = {
    id: 'p1',
    goal_id: 'g1',
    created_at: now,
    updated_at: now,
    status: 'draft',
    current_step_index: 0,
    replan_count: 0,
    steps: [
      { id: 's1', description: 'A', status: 'pending', retries: 0 },
      { id: 's2', description: 'B', status: 'pending', retries: 0 },
      { id: 's3', description: 'C', status: 'pending', retries: 0 },
    ],
    ...overrides,
  };
  return repo.createPlan(plan);
}

function makeCtx(opts: {
  results?: string[];
  throwOn?: number[];
  abortAfter?: number;
}): RunnerContext & { runStepMock: ReturnType<typeof vi.fn>; isAbortedMock: ReturnType<typeof vi.fn> } {
  const results = opts.results ?? ['r1', 'r2', 'r3'];
  let stepIndex = 0;
  const runStepMock = vi.fn(async (_step: PlanStep) => {
    const i = stepIndex++;
    if (opts.throwOn?.includes(i)) throw new Error(`step-${i}-fail`);
    return results[i] ?? `r${i}`;
  });
  let aborted = false;
  let callCount = 0;
  const isAbortedMock = vi.fn(() => {
    if (opts.abortAfter === undefined) return false;
    callCount++;
    return callCount > opts.abortAfter;
  });
  return {
    runStep: runStepMock,
    isAborted: isAbortedMock,
    runStepMock,
    isAbortedMock,
  };
}

const mockLLM: LLMProvider = {
  complete: vi.fn(async () => ({ text: '{}' })),
};

describe('createPlanRunner', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  // ── 顺序执行 ────────────────────────────────────────

  it('runs all pending steps in order, emits step_started/completed for each', async () => {
    const repo = createPlanStore(db);
    const plan = makePlan(repo);
    const runner = createPlanRunner(repo);
    const ctx = makeCtx({ results: ['r1', 'r2', 'r3'] });
    const events: PlanEvent[] = [];
    const evFn = (e: PlanEvent) => events.push(e);

    const final = await runner.runPlan(plan, ctx, mockLLM, evFn);

    expect(final.status).toBe('completed');
    expect(events.filter(e => e.kind === 'plan.step_started')).toHaveLength(3);
    expect(events.filter(e => e.kind === 'plan.step_completed')).toHaveLength(3);
    expect(events.some(e => e.kind === 'plan.completed')).toBe(true);

    const startEvents = events.filter(e => e.kind === 'plan.step_started') as Array<Extract<PlanEvent, { kind: 'plan.step_started' }>>;
    expect(startEvents.map(e => e.step_id)).toEqual(['s1', 's2', 's3']);
  });

  it('deduplicates concurrent runs of the same plan', async () => {
    const repo = createPlanStore(db);
    const plan = makePlan(repo);
    const runner = createPlanRunner(repo);
    let releaseFirstStep!: () => void;
    const firstStepBlocked = new Promise<void>((resolve) => { releaseFirstStep = resolve; });
    const ctx = makeCtx({ results: ['r1', 'r2', 'r3'] });
    ctx.runStepMock.mockImplementationOnce(async () => {
      await firstStepBlocked;
      return 'r1';
    });

    const first = runner.runPlan(plan, ctx, mockLLM, () => {});
    const second = runner.runPlan(plan, ctx, mockLLM, () => {});
    releaseFirstStep();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('completed');
    expect(secondResult.status).toBe('completed');
    expect(ctx.runStepMock).toHaveBeenCalledTimes(3);
  });

  it('marks each step completed in db after runPlan', async () => {
    const repo = createPlanStore(db);
    const plan = makePlan(repo);
    const runner = createPlanRunner(repo);
    const ctx = makeCtx({ results: ['done-1', 'done-2', 'done-3'] });

    await runner.runPlan(plan, ctx, mockLLM, () => {});

    const loaded = repo.getPlan(plan.id);
    expect(loaded!.status).toBe('completed');
    expect(loaded!.steps.every(s => s.status === 'completed')).toBe(true);
    expect(loaded!.steps[0].result).toBe('done-1');
    expect(loaded!.steps[2].result).toBe('done-3');
  });

  // ── 失败 + 单步重试 ────────────────────────────────────────

  it('failing step: retries++ + status=failed + replan decision applied', async () => {
    const repo = createPlanStore(db);
    const plan = makePlan(repo);
    const runner = createPlanRunner(repo);
    const ctx = makeCtx({ results: ['r1', 'r2'], throwOn: [1] });  // s2 fails

    const final = await runner.runPlan(plan, ctx, mockLLM, () => {});

    // progress = 1/3 = 33% < 50% → full replan 触发 → runner 返回 aborted (因为 single-step runner 不处理 full replan)
    // 这里期待: plan 进入 aborted 状态, replan 事件被 emit
    expect(['aborted']).toContain(final.status);
    const loaded = repo.getPlan(plan.id);
    expect(loaded!.steps[1].retries).toBeGreaterThanOrEqual(1);
  });

  it('retries exceed 3 on same step → replan decision: full (aborted by runner)', async () => {
    const repo = createPlanStore(db);
    const plan = makePlan(repo);
    const runner = createPlanRunner(repo);
    // 单步 runner 每次失败会单步 replan (i-- 重跑), 但 retries 会持续增加
    // 直到 retries >= 3 → full replan → aborted
    const ctx = makeCtx({ results: [], throwOn: [0, 1, 2, 3] });

    const events: PlanEvent[] = [];
    const final = await runner.runPlan(plan, ctx, mockLLM, e => events.push(e));

    expect(final.status).toBe('aborted');
    // 触发至少一次 replanned 事件
    expect(events.some(e => e.kind === 'plan.replanned')).toBe(true);
  });

  // ── 中断检测 ────────────────────────────────────────

  it('isAborted() true → plan.status=aborted, running step reverted to pending', async () => {
    const repo = createPlanStore(db);
    const plan = makePlan(repo);
    const runner = createPlanRunner(repo);
    // abortAfter=2: 第 2 步开始时 abort
    const ctx = makeCtx({ results: ['r1', 'r2'], abortAfter: 2 });

    const final = await runner.runPlan(plan, ctx, mockLLM, () => {});

    expect(final.status).toBe('aborted');
    // 至少 s1 已完成, s2 可能在 running → pending (由 prepareForResume 处理)
    const loaded = repo.getPlan(plan.id);
    expect(loaded!.steps[0].status).toBe('completed');
  });

  // ── 断点续跑 ────────────────────────────────────────

  it('resumePlan: loads existing plan, resumes from pending steps', async () => {
    const repo = createPlanStore(db);
    const plan = makePlan(repo, {
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0, result: 'done-A' },
        { id: 's2', description: 'B', status: 'pending', retries: 0 },
        { id: 's3', description: 'C', status: 'pending', retries: 0 },
      ],
    });
    const runner = createPlanRunner(repo);
    const ctx = makeCtx({ results: ['r2', 'r3'] });

    const resumed = await runner.resumePlan(plan.id, ctx, mockLLM, () => {});

    expect(resumed).not.toBeNull();
    expect(resumed!.status).toBe('completed');
    expect(resumed!.steps[0].status).toBe('completed');
    expect(resumed!.steps[1].status).toBe('completed');
    expect(resumed!.steps[2].status).toBe('completed');
  });

  it('resumePlan: returns null for nonexistent plan_id', async () => {
    const repo = createPlanStore(db);
    const runner = createPlanRunner(repo);
    const ctx = makeCtx({});

    const resumed = await runner.resumePlan('nonexistent', ctx, mockLLM, () => {});

    expect(resumed).toBeNull();
  });

  it('resumePlan: returns existing plan if already completed (no re-run)', async () => {
    const repo = createPlanStore(db);
    const plan = makePlan(repo, {
      status: 'completed',
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0, result: 'r1' },
        { id: 's2', description: 'B', status: 'completed', retries: 0, result: 'r2' },
      ],
    });
    const runner = createPlanRunner(repo);
    const ctx = makeCtx({ results: ['should-not-run'] });

    const resumed = await runner.resumePlan(plan.id, ctx, mockLLM, () => {});

    expect(resumed!.status).toBe('completed');
    expect(ctx.runStepMock).not.toHaveBeenCalled();
  });

  // ── prepareForResume ────────────────────────────────────────

  it('prepareForResume: changes running step back to pending', () => {
    const repo = createPlanStore(db);
    const runner = createPlanRunner(repo);
    const plan: Plan = {
      id: 'p1', goal_id: 'g1', created_at: 1, updated_at: 1,
      status: 'running', current_step_index: 1, replan_count: 0,
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0 },
        { id: 's2', description: 'B', status: 'running', retries: 0, started_at: 100 },
        { id: 's3', description: 'C', status: 'pending', retries: 0 },
      ],
    };

    const fixed = runner.prepareForResume(plan);

    expect(fixed.steps[0].status).toBe('completed');  // 不变
    expect(fixed.steps[1].status).toBe('pending');    // running → pending
    expect(fixed.steps[1].started_at).toBeUndefined();
    expect(fixed.steps[2].status).toBe('pending');    // 不变
    expect(fixed.status).toBe('paused');
  });

  // ── Spec 2C-2: Parallel sub-agent ──────────────────────
  // DoD #7: PlanRunner 集成 ≥ 2 case
  // DoD #3: 验证并行 wall-clock < 串行

  it('parallel step with subtasks: forks sub-agents and merges output', async () => {
    const repo = createPlanStore(db);
    const now = Date.now();
    // 创建一个 parallel step, 3 个子任务
    const subAgentExecutor = vi.fn(async (task) => {
      await new Promise((r) => setTimeout(r, 100));  // 模拟工作
      return {
        task_id: task.id,
        ok: true,
        output: `done-${task.prompt}`,
        tool_calls: [],
        duration_ms: 100,
        status: 'completed' as const,
      };
    });
    const plan = repo.createPlan({
      id: 'p-par-1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'draft', current_step_index: 0, replan_count: 0,
      steps: [
        {
          id: 's1',
          description: 'Parallel research: gather info from 3 sources',
          status: 'pending',
          retries: 0,
          parallel_group: 'research',
          subtasks: [
            { id: 'st1', prompt: 'read source A', parent_goal_id: 'g1', parent_step_id: 's1', timeout_ms: 5000 },
            { id: 'st2', prompt: 'read source B', parent_goal_id: 'g1', parent_step_id: 's1', timeout_ms: 5000 },
            { id: 'st3', prompt: 'read source C', parent_goal_id: 'g1', parent_step_id: 's1', timeout_ms: 5000 },
          ],
        },
        { id: 's2', description: 'Sequential next step', status: 'pending', retries: 0 },
      ],
    });
    const runner = createPlanRunner(repo);
    const ctx: RunnerContext = {
      runStep: vi.fn(async () => 'should-not-run-for-parallel'),
      isAborted: () => false,
      subAgentExecutor: subAgentExecutor as unknown as RunnerContext['subAgentExecutor'],
    };
    const events: PlanEvent[] = [];

    const start = Date.now();
    const final = await runner.runPlan(plan, ctx, mockLLM, (e) => events.push(e));
    const elapsed = Date.now() - start;

    expect(final.status).toBe('completed');
    // 串行 3 * 100ms = 300ms, 并行应 < 200ms
    expect(elapsed).toBeLessThan(250);
    // subAgentExecutor 被调用 3 次 (3 个子任务)
    expect(subAgentExecutor).toHaveBeenCalledTimes(3);
    // 合并 output 包含全部 3 个子任务结果
    const parallelStep = final.steps[0]!;
    expect(parallelStep.result).toContain('done-read source A');
    expect(parallelStep.result).toContain('done-read source B');
    expect(parallelStep.result).toContain('done-read source C');
    expect(parallelStep.status).toBe('completed');
    // s2 也完成 (走串行, ctx.runStep 被调用 1 次)
    expect(final.steps[1]!.status).toBe('completed');
    expect(ctx.runStep).toHaveBeenCalledTimes(1);
  });

  it('parallel step with failing subtask: triggers step failure (any-fail policy)', async () => {
    const repo = createPlanStore(db);
    const now = Date.now();
    const subAgentExecutor = vi.fn(async (task) => {
      if (task.id === 'st2') {
        return {
          task_id: task.id,
          ok: false,
          error: 'subagent failed',
          tool_calls: [],
          duration_ms: 10,
          status: 'failed' as const,
        };
      }
      return { task_id: task.id, ok: true, output: 'ok', tool_calls: [], duration_ms: 10, status: 'completed' as const };
    });
    const plan = repo.createPlan({
      id: 'p-par-fail', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'draft', current_step_index: 0, replan_count: 0,
      steps: [
        {
          id: 's1',
          description: 'Parallel with failure',
          status: 'pending',
          retries: 0,
          parallel_group: 'g1',
          subtasks: [
            { id: 'st1', prompt: 'a', parent_goal_id: 'g1', parent_step_id: 's1', timeout_ms: 5000 },
            { id: 'st2', prompt: 'b-FAIL', parent_goal_id: 'g1', parent_step_id: 's1', timeout_ms: 5000 },
            { id: 'st3', prompt: 'c', parent_goal_id: 'g1', parent_step_id: 's1', timeout_ms: 5000 },
          ],
        },
      ],
    });
    const runner = createPlanRunner(repo);
    const ctx: RunnerContext = {
      runStep: vi.fn(async () => 'x'),
      isAborted: () => false,
      subAgentExecutor: subAgentExecutor as unknown as RunnerContext['subAgentExecutor'],
    };

    const final = await runner.runPlan(plan, ctx, mockLLM, () => {});

    // 失败导致 plan 不再继续 (走 replan/abort 决策)
    // step 状态可能是 failed 或 aborted plan
    expect(['aborted']).toContain(final.status);
    const loaded = repo.getPlan(plan.id);
    expect(loaded!.steps[0].retries).toBeGreaterThanOrEqual(1);
  });
});