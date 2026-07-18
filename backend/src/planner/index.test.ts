/**
 * Planner 测试 — planFromGoal
 * 灵枢 V2 Spec 2C-1
 *
 * TDD: 先写测试, 再写实现 (上面已经写了实现).
 */

import { describe, it, expect, vi } from 'vitest';
import { planFromGoal } from './index.js';
import { parseGoal } from '../agent/goal.js';
import type { LLMProvider } from '../agent/verifier.js';

function makeLLM(text: string): LLMProvider {
  return {
    complete: vi.fn(async () => ({ text })),
  };
}

function makeFailingLLM(err: Error): LLMProvider {
  return {
    complete: vi.fn(async () => { throw err; }),
  };
}

describe('planFromGoal', () => {
  it('returns Plan with 3-5 steps when LLM gives valid JSON', async () => {
    const goal = parseGoal('目标: 修好 login 失败\n验收:\n1) 单元测试通过\n2) 加新 commit');
    const llm = makeLLM(JSON.stringify({
      steps: [
        { description: '读 auth/login.ts', acceptance: ['看到 login 函数'] },
        { description: '定位 401 错误来源' },
        { description: '修复 token 验证逻辑', acceptance: ['本地测试通过'] },
      ],
    }));

    const plan = await planFromGoal(goal, llm);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].description).toBe('读 auth/login.ts');
    expect(plan.steps[0].status).toBe('pending');
    expect(plan.steps[0].retries).toBe(0);
  });

  it('associates plan with goal.id', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a\n2) b\n3) c');
    const llm = makeLLM(JSON.stringify({
      steps: [{ description: 's1' }, { description: 's2' }, { description: 's3' }],
    }));

    const plan = await planFromGoal(goal, llm);
    expect(plan.goal_id).toBe(goal.id);
  });

  it('initializes plan status=draft, current_step_index=0, replan_count=0', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a\n2) b\n3) c');
    const llm = makeLLM(JSON.stringify({
      steps: [{ description: 's1' }, { description: 's2' }, { description: 's3' }],
    }));

    const plan = await planFromGoal(goal, llm);
    expect(plan.status).toBe('draft');
    expect(plan.current_step_index).toBe(0);
    expect(plan.replan_count).toBe(0);
  });

  it('truncates steps to maxSteps (default 5)', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const llm = makeLLM(JSON.stringify({
      steps: Array.from({ length: 8 }, (_, i) => ({ description: `step-${i}` })),
    }));

    const plan = await planFromGoal(goal, llm);
    expect(plan.steps).toHaveLength(5);  // default max=5
  });

  it('throws when LLM returns fewer than minSteps (default 3)', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const llm = makeLLM(JSON.stringify({
      steps: [{ description: 'only-one' }],
    }));

    await expect(planFromGoal(goal, llm)).rejects.toThrow(/returned 1 steps/);
  });

  it('throws when LLM returns non-JSON', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const llm = makeLLM('this is not json');
    await expect(planFromGoal(goal, llm)).rejects.toThrow();
  });

  it('throws when LLM.complete itself throws (network error)', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const llm = makeFailingLLM(new Error('network down'));
    await expect(planFromGoal(goal, llm)).rejects.toThrow('network down');
  });

  it('respects custom minSteps and maxSteps config', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const llm = makeLLM(JSON.stringify({
      steps: [
        { description: 's1' },
        { description: 's2' },
        { description: 's3' },
        { description: 's4' },
      ],
    }));

    const plan = await planFromGoal(goal, llm, { minSteps: 2, maxSteps: 4 });
    expect(plan.steps).toHaveLength(4);
  });

  it('assigns unique step ids', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const llm = makeLLM(JSON.stringify({
      steps: [{ description: 's1' }, { description: 's2' }, { description: 's3' }],
    }));

    const plan = await planFromGoal(goal, llm);
    const ids = new Set(plan.steps.map(s => s.id));
    expect(ids.size).toBe(3);  // 全部唯一
  });

  it('handles empty acceptance list gracefully', async () => {
    const goal = parseGoal('目标: simple task');
    const llm = makeLLM(JSON.stringify({
      steps: [{ description: 's1' }, { description: 's2' }, { description: 's3' }],
    }));

    const plan = await planFromGoal(goal, llm);
    expect(plan.steps).toHaveLength(3);
  });

  it('preserves step-level acceptance when LLM provides it', async () => {
    const goal = parseGoal('目标: foo\n验收:\n1) a');
    const llm = makeLLM(JSON.stringify({
      steps: [
        { description: 's1', acceptance: ['sub-1', 'sub-2'] },
        { description: 's2' },
        { description: 's3' },
      ],
    }));

    const plan = await planFromGoal(goal, llm);
    expect(plan.steps[0].acceptance).toEqual(['sub-1', 'sub-2']);
    expect(plan.steps[1].acceptance).toBeUndefined();
  });
});