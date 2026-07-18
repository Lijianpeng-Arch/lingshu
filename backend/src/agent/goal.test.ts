/**
 * goal.ts 测试 — parseGoal + runGoalLoop
 * 灵枢 V2 — Goal 系统核心
 *
 * 用 mock AgentContext + mock LLMProvider 跑集成测试，
 * 不真连 LLM / 不真做 UI 弹窗。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GoalBudgetExceededError,
  parseGoal,
  runGoalLoop,
  type Goal,
  type AgentContext,
} from './goal.js';
import { parseAcceptance, allPassed } from './acceptance.js';
import type { LLMProvider, VerdictResult } from './verifier.js';

// ── Mock 工厂 ─────────────────────────────────────────────

interface MockAgentContextOpts {
  summaries?: string[];
  abortAfter?: number;
}

function makeMockContext(opts: MockAgentContextOpts = {}): AgentContext & {
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
    if (opts.abortAfter !== undefined && callCount > opts.abortAfter) {
      // abort 之后直接停
    }
    return summaries[idx % summaries.length] ?? 'fallback';
  });

  // isAborted: 调用次数超过 abortAfter 返回 true
  const isAbortedMock = vi.fn(() => {
    if (opts.abortAfter === undefined) return false;
    return callCount > opts.abortAfter;
  });

  const askUserContinueMock = vi.fn(async (_msg: string) => {
    // 默认: 继续
  });

  return {
    runOnce: runOnceMock,
    isAborted: isAbortedMock,
    askUserContinue: askUserContinueMock,
    askUserContinueMock,
    runOnceMock,
    isAbortedMock,
  };
}

function makeMockLLM(
  verdicts: Array<{ results: VerdictResult[] } | 'all-pass' | 'all-fail'>
): LLMProvider {
  let i = 0;
  const complete = vi.fn(async (_req: { prompt: string; json?: boolean }) => {
    const v = verdicts[i % verdicts.length];
    i++;
    if (v === 'all-pass') {
      return { text: JSON.stringify({ results: [{ criterion: '', passed: true, evidence: 'all-pass' }] }) };
    }
    if (v === 'all-fail') {
      return { text: JSON.stringify({ results: [{ criterion: '', passed: false, evidence: 'all-fail' }] }) };
    }
    return { text: JSON.stringify(v) };
  });
  return { complete };
}

// 让 mock LLM 给定 N 条 criterion 时全部返回 passed=true
function allPassVerdictForCriteria(criteria: Goal['acceptance']) {
  return {
    results: criteria.map(c => ({ criterion: c.text, passed: true, evidence: 'mock-pass' })),
  };
}

function allFailVerdictForCriteria(criteria: Goal['acceptance']) {
  return {
    results: criteria.map(c => ({ criterion: c.text, passed: false, evidence: 'mock-fail' })),
  };
}

// ── parseGoal 单测 ─────────────────────────────────────────

describe('parseGoal', () => {
  it('parses statement + acceptance (numbered)', () => {
    const g = parseGoal('目标: 修好 login\n验收:\n1) 测试全绿\n2) 新增 commit');
    expect(g.statement).toBe('修好 login');
    expect(g.acceptance).toHaveLength(2);
    expect(g.acceptance[0]?.text).toBe('测试全绿');
    expect(g.acceptance[1]?.text).toBe('新增 commit');
  });

  it('handles statement only (no acceptance block)', () => {
    const g = parseGoal('目标: 跑测试');
    expect(g.statement).toBe('跑测试');
    expect(g.acceptance).toHaveLength(0);
  });

  it('handles full-width colon (：)', () => {
    const g = parseGoal('目标：写文档\n验收：\n1) README.md');
    expect(g.statement).toBe('写文档');
    expect(g.acceptance[0]?.text).toBe('README.md');
  });

  it('handles fallback (no 目标: prefix → whole input as statement)', () => {
    const g = parseGoal('修好 login bug');
    expect(g.statement).toBe('修好 login bug');
    expect(g.acceptance).toHaveLength(0);
  });

  it('generates unique id', () => {
    const g1 = parseGoal('目标: A');
    const g2 = parseGoal('目标: A');
    expect(g1.id).not.toBe(g2.id);
  });

  it('initializes status=running, iterations=0, started_at≈now', () => {
    const before = Date.now();
    const g = parseGoal('目标: foo');
    const after = Date.now();
    expect(g.status).toBe('running');
    expect(g.iterations).toBe(0);
    expect(g.started_at).toBeGreaterThanOrEqual(before);
    expect(g.started_at).toBeLessThanOrEqual(after);
  });

  it('initializes contextSummary empty string', () => {
    const g = parseGoal('目标: foo');
    expect(g.contextSummary).toBe('');
  });
});

// ── runGoalLoop 集成测试（mock AgentContext + mock LLM） ──────

// ---- I2 Spec 2A: verifier try/catch embedded in runGoalLoop ----
// Borrowed from Hermes convergence.ts resilience pattern.
// goal.ts owns the try/catch now — verifier JSON parse failure must NOT abort the loop.

describe('runGoalLoop — verifier resilience (I2)', () => {
  it('verifier throws → loop continues iterating (no abort)', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const ctx = makeMockContext({ summaries: ['s1', 's2'] });
    const llm: LLMProvider = {
      complete: vi.fn(async () => {
        // Simulate checkAcceptance throwing on JSON.parse of non-JSON output
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      }),
    };
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // abortAfter=2 ensures the loop terminates after 2 iterations
    ctx.isAbortedMock.mockImplementation((() => {
      let c = 0;
      return () => { c++; return c > 2; };
    })());

    const result = await runGoalLoop(goal, ctx, llm, () => {});

    expect(result.status).toBe('aborted'); // terminates via abort, not via throw
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    // Verifier error was logged, not bubbled
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[goal] verifier error'),
      expect.any(String),
    );
    consoleErrSpy.mockRestore();
  });
});

describe('runGoalLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-16T10:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes immediately when all acceptance pass on first iteration', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) 测试全绿');
    const ctx = makeMockContext({ summaries: ['did stuff'] });
    const llm = makeMockLLM([allPassVerdictForCriteria(goal.acceptance)]);

    const onIteration = vi.fn();
    const result = await runGoalLoop(goal, ctx, llm, onIteration);

    expect(result.status).toBe('complete');
    expect(result.iterations).toBe(1);
    expect(result.acceptance[0]?.passed).toBe(true);
    expect(onIteration).toHaveBeenCalledTimes(1);
  });

  it('loops until all pass (partial → complete)', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a\n2) b');
    const ctx = makeMockContext({ summaries: ['s1', 's2', 's3'] });
    // 第 1 次: b fail; 第 2 次: 全部 pass
    const llm = makeMockLLM([
      {
        results: [
          { criterion: 'a', passed: true, evidence: 'ok' },
          { criterion: 'b', passed: false, evidence: 'pending' },
        ],
      },
      allPassVerdictForCriteria(goal.acceptance),
    ]);

    const result = await runGoalLoop(goal, ctx, llm, () => {});
    expect(result.status).toBe('complete');
    expect(result.iterations).toBe(2);
    expect(result.acceptance[1]?.passed).toBe(true);
  });

  it('aborts cleanly when isAborted() becomes true', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    // 1 次后 abort（第 2 次进入循环时 isAborted=true）
    const ctx = makeMockContext({ summaries: ['s'], abortAfter: 1 });
    // 第 1 次 fail（不通过验收），第 2 次本来要 abort 但 llm 还会先调一次
    const llm = makeMockLLM([
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
    ]);

    const result = await runGoalLoop(goal, ctx, llm, () => {});
    expect(result.status).toBe('aborted');
  });

  it('handles empty acceptance list → immediate complete (vacuously true)', async () => {
    const goal = parseGoal('目标: foo');
    const ctx = makeMockContext({ summaries: ['s'] });
    const llm = makeMockLLM([{ results: [] }]);

    const result = await runGoalLoop(goal, ctx, llm, () => {});
    expect(result.status).toBe('complete');
    expect(result.iterations).toBe(1);
    // 没调 LLM 也成立（空清单不需校验）
    // 但我们的实现还是会调 — 验证至少不报错
  });

  it('handles single criterion completion', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) only');
    const ctx = makeMockContext({ summaries: ['did'] });
    const llm = makeMockLLM([allPassVerdictForCriteria(goal.acceptance)]);

    const result = await runGoalLoop(goal, ctx, llm, () => {});
    expect(result.status).toBe('complete');
    expect(result.iterations).toBe(1);
  });

  it('calls onIteration once per iteration with current goal state', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a\n2) b');
    const ctx = makeMockContext({ summaries: ['s1', 's2', 's3'] });
    const llm = makeMockLLM([
      { results: [{ criterion: 'a', passed: true, evidence: 'ok' }, { criterion: 'b', passed: false, evidence: 'no' }] },
      allPassVerdictForCriteria(goal.acceptance),
    ]);

    const seen: Goal[] = [];
    await runGoalLoop(goal, ctx, llm, (g) => { seen.push({ ...g, acceptance: [...g.acceptance] }); });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.iterations).toBe(1);
    expect(seen[1]?.iterations).toBe(2);
  });

  it('updates goal.contextSummary from ctx.runOnce output', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const ctx = makeMockContext({ summaries: ['execution-log-1'] });
    const llm = makeMockLLM([allPassVerdictForCriteria(goal.acceptance)]);

    const result = await runGoalLoop(goal, ctx, llm, () => {});
    expect(result.contextSummary).toBe('execution-log-1');
  });

  it('writes passed + evidence back into acceptance from verdict', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const ctx = makeMockContext({ summaries: ['s'] });
    const llm = makeMockLLM([
      { results: [{ criterion: 'a', passed: true, evidence: 'specific-evidence-42' }] },
    ]);

    const result = await runGoalLoop(goal, ctx, llm, () => {});
    expect(result.acceptance[0]?.passed).toBe(true);
    expect(result.acceptance[0]?.evidence).toBe('specific-evidence-42');
  });

  it('soft-safety-net: asks user after >30 min (iterations % 10 == 0)', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    // started_at 是过去时间（> 30 分钟之前）
    goal.started_at = Date.now() - 31 * 60 * 1000;
    const ctx = makeMockContext({ summaries: ['s'] });
    // 第 10 次正好是 % 10 == 0 — 需要 10 次都失败
    const failResults = allFailVerdictForCriteria(goal.acceptance);
    const verdicts: typeof failResults[] = [];
    for (let i = 0; i < 12; i++) verdicts.push(failResults);
    const llm = makeMockLLM(verdicts);

    // 跑 10 次就停（用 abortAfter=10）
    ctx.isAbortedMock.mockImplementation(() => false);
    let callCount = 0;
    const realRunOnce = ctx.runOnceMock.getMockImplementation();
    ctx.runOnceMock.mockImplementation(async (g: Goal) => {
      callCount++;
      if (callCount > 10) {
        ctx.isAbortedMock.mockImplementation(() => true);
      }
      return realRunOnce ? realRunOnce(g) : 's';
    });

    await runGoalLoop(goal, ctx, llm, () => {});
    expect(ctx.askUserContinueMock).toHaveBeenCalled();
    // 验证消息含时长
    const msg = (ctx.askUserContinueMock.mock.calls[0] as unknown as string[])[0];
    expect(msg).toContain('分钟');
  });

  it('soft-safety-net does NOT ask before 30 minutes', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    goal.started_at = Date.now() - 5 * 60 * 1000; // 5 分钟前
    const ctx = makeMockContext({ summaries: ['s'], abortAfter: 3 });
    const llm = makeMockLLM([
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
    ]);

    await runGoalLoop(goal, ctx, llm, () => {});
    expect(ctx.askUserContinueMock).not.toHaveBeenCalled();
  });

  it('throws after the hard iteration budget is exhausted', async () => {
    const goal = parseGoal('目标: never done\n验收:\n1) impossible');
    const ctx = makeMockContext({ summaries: ['still working'] });
    const llm = makeMockLLM([allFailVerdictForCriteria(goal.acceptance)]);

    await expect(runGoalLoop(goal, ctx, llm, () => {})).rejects.toBeInstanceOf(
      GoalBudgetExceededError,
    );
    expect(goal.iterations).toBe(200);
    expect(ctx.runOnceMock).toHaveBeenCalledTimes(200);
  });

  it('continues looping until completion within the hard budget', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const ctx = makeMockContext({ summaries: ['s', 's', 's', 's', 's'], abortAfter: 100 });
    // 一直 fail
    const llm = makeMockLLM([
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'a', passed: false, evidence: 'no' }] },
      { results: [{ criterion: 'a', passed: true, evidence: 'finally' }] },
    ]);

    const result = await runGoalLoop(goal, ctx, llm, () => {});
    expect(result.status).toBe('complete');
    expect(result.iterations).toBe(5);
  });
});

// ── 整合: parseGoal + parseAcceptance + allPassed ──────────

describe('integration: parseGoal → allPassed', () => {
  it('parsed empty acceptance → allPassed vacuously true', () => {
    const g = parseGoal('目标: foo');
    expect(allPassed(g.acceptance)).toBe(true);
  });

  it('parsed acceptance without passed → allPassed false', () => {
    const g = parseGoal('目标: foo\n验收:\n1) a\n2) b');
    expect(allPassed(g.acceptance)).toBe(false);
  });

  it('parseAcceptance same format → same result', () => {
    const text = '1) foo\n2) bar';
    expect(parseAcceptance(text)).toEqual(parseGoal('目标: x\n验收:\n' + text).acceptance);
  });
});