/**
 * Replan 决策测试 — shouldReplan + rebuildPlan + rebuildSingleStep
 * 灵枢 V2 Spec 2C-1
 */

import { describe, it, expect } from 'vitest';
import {
  shouldReplan,
  rebuildPlan,
  rebuildSingleStep,
  MAX_RETRIES,
  MAX_REPLANS,
  REPLAN_PROGRESS_THRESHOLD,
} from './replan.js';
import type { Plan, PlanStep } from '../plan/types.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const now = Date.now();
  const steps: PlanStep[] = overrides.steps ?? [
    { id: 's1', description: 'A', status: 'completed', retries: 0 },
    { id: 's2', description: 'B', status: 'completed', retries: 0 },
    { id: 's3', description: 'C', status: 'failed', retries: 1 },
    { id: 's4', description: 'D', status: 'pending', retries: 0 },
  ];
  return {
    id: 'p1',
    goal_id: 'g1',
    steps,
    created_at: now,
    updated_at: now,
    status: 'running',
    current_step_index: 2,
    replan_count: 0,
    ...overrides,
  };
}

describe('shouldReplan', () => {
  it('retries >= MAX_RETRIES → full replan', () => {
    const plan = makePlan();
    const failed: PlanStep = { id: 's3', description: 'C', status: 'failed', retries: MAX_RETRIES };
    const decision = shouldReplan(plan, failed);
    expect(decision.kind).toBe('full');
    expect(decision.reason).toContain('retries');
  });

  it('progress < 50% (early stage) + single failure → full replan', () => {
    const plan = makePlan({
      steps: [
        { id: 's1', description: 'A', status: 'failed', retries: 1 },
        { id: 's2', description: 'B', status: 'pending', retries: 0 },
      ],
      current_step_index: 0,
      replan_count: 0,
    });
    const failed: PlanStep = { id: 's1', description: 'A', status: 'failed', retries: 1 };
    const decision = shouldReplan(plan, failed);
    expect(decision.kind).toBe('full');
    expect(decision.reason).toMatch(/progress.*<.*50%/);
  });

  it('progress >= 50% + single failure → single-step replan', () => {
    const plan = makePlan();  // 2/4 completed = 50%
    const failed: PlanStep = { id: 's3', description: 'C', status: 'failed', retries: 1 };
    const decision = shouldReplan(plan, failed);
    expect(decision.kind).toBe('single-step');
    expect(decision.stepId).toBe('s3');
  });

  it('progress = 100% (all done except failed) → single-step replan', () => {
    const plan = makePlan({
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0 },
        { id: 's2', description: 'B', status: 'completed', retries: 0 },
        { id: 's3', description: 'C', status: 'failed', retries: 1 },
      ],
      current_step_index: 2,
    });
    const failed: PlanStep = { id: 's3', description: 'C', status: 'failed', retries: 1 };
    const decision = shouldReplan(plan, failed);
    expect(decision.kind).toBe('single-step');
  });

  it('replan_count >= MAX_REPLANS → abort', () => {
    const plan = makePlan({ replan_count: MAX_REPLANS });
    const failed: PlanStep = { id: 's3', description: 'C', status: 'failed', retries: 1 };
    const decision = shouldReplan(plan, failed);
    expect(decision.kind).toBe('abort');
    expect(decision.reason).toContain(`>= ${MAX_REPLANS}`);
  });

  it('userAborted → abort (无论其他条件)', () => {
    const plan = makePlan();
    const failed: PlanStep = { id: 's3', description: 'C', status: 'failed', retries: 1 };
    const decision = shouldReplan(plan, failed, true);
    expect(decision.kind).toBe('abort');
    expect(decision.reason).toContain('user aborted');
  });

  it('exports MAX_RETRIES=3, MAX_REPLANS=3, threshold=0.5 (per spec §2.4)', () => {
    expect(MAX_RETRIES).toBe(3);
    expect(MAX_REPLANS).toBe(3);
    expect(REPLAN_PROGRESS_THRESHOLD).toBe(0.5);
  });
});

describe('rebuildPlan', () => {
  it('keeps completed/skipped steps, replaces failed/pending', () => {
    const plan = makePlan({
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0 },
        { id: 's2', description: 'B', status: 'completed', retries: 0 },
        { id: 's3', description: 'C-old', status: 'failed', retries: 3 },
        { id: 's4', description: 'D-old', status: 'pending', retries: 0 },
      ],
    });

    const newPlan = rebuildPlan(plan, ['C-new', 'D-new']);

    expect(newPlan.steps).toHaveLength(4);
    expect(newPlan.steps[0].description).toBe('A');
    expect(newPlan.steps[0].status).toBe('completed');
    expect(newPlan.steps[1].description).toBe('B');
    expect(newPlan.steps[1].status).toBe('completed');
    expect(newPlan.steps[2].description).toBe('C-new');
    expect(newPlan.steps[2].status).toBe('pending');
    expect(newPlan.steps[3].description).toBe('D-new');
    expect(newPlan.steps[3].status).toBe('pending');
  });

  it('new plan has different id, replan_count+1, status=draft', () => {
    const plan = makePlan({ replan_count: 1 });
    const newPlan = rebuildPlan(plan, ['x']);
    expect(newPlan.id).not.toBe(plan.id);
    expect(newPlan.replan_count).toBe(2);
    expect(newPlan.status).toBe('draft');
  });

  it('preserves goal_id across replan (same goal can be replanned many times)', () => {
    const plan = makePlan({ goal_id: 'goal-abc' });
    const newPlan = rebuildPlan(plan, ['x']);
    expect(newPlan.goal_id).toBe('goal-abc');
  });
});

describe('rebuildSingleStep', () => {
  it('replaces only the failed step description, resets status+retries+result', () => {
    const plan = makePlan({
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0 },
        { id: 's2', description: 'B', status: 'completed', retries: 0 },
        { id: 's3', description: 'C-old', status: 'failed', retries: 3, result: 'old-fail' },
      ],
    });

    const newSteps = rebuildSingleStep(plan, 's3', 'C-new');

    expect(newSteps[0].description).toBe('A');
    expect(newSteps[0].status).toBe('completed');
    expect(newSteps[2].description).toBe('C-new');
    expect(newSteps[2].status).toBe('pending');
    expect(newSteps[2].retries).toBe(0);
    expect(newSteps[2].result).toBeUndefined();
  });

  it('does not modify other steps', () => {
    const plan = makePlan({
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0 },
        { id: 's2', description: 'B', status: 'completed', retries: 0 },
      ],
    });

    const newSteps = rebuildSingleStep(plan, 'nonexistent', 'whatever');
    expect(newSteps[0]).toEqual(plan.steps[0]);
    expect(newSteps[1]).toEqual(plan.steps[1]);
  });
});