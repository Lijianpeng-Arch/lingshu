/**
 * PlanStore 测试 — 灵枢 V2 Plan 持久化
 * Spec 2C-1
 *
 * TDD: 先写测试, 再写实现.
 *
 * 借 LangGraph checkpointer.py 模式 (SQLite plan persistence).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPlanStore, type PlanRepo } from './store.js';
import type { Plan, PlanStep, PlanStatus, StepStatus } from './types.js';

describe('createPlanStore', () => {
  let db: Database.Database;
  let repo: PlanRepo;

  beforeEach(() => {
    // 用真 SQLite (better-sqlite3 in-memory), 但要先建表 (绕过 createSqlite 以隔离)
    db = new Database(':memory:');
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
    repo = createPlanStore(db);
  });

  // ── Plan CRUD ────────────────────────────────────────

  it('createPlan: inserts plan with steps, returns full plan', () => {
    const now = Date.now();
    const steps: PlanStep[] = [
      { id: 's1', description: 'read code', status: 'pending', retries: 0 },
      { id: 's2', description: 'fix bug', status: 'pending', retries: 0 },
      { id: 's3', description: 'run tests', status: 'pending', retries: 0 },
    ];
    const plan: Plan = {
      id: 'plan-1',
      goal_id: 'goal-1',
      steps,
      created_at: now,
      updated_at: now,
      status: 'draft',
      current_step_index: 0,
      replan_count: 0,
    };

    const stored = repo.createPlan(plan);

    expect(stored.id).toBe('plan-1');
    expect(stored.goal_id).toBe('goal-1');
    expect(stored.steps).toHaveLength(3);
    expect(stored.steps[0].description).toBe('read code');
  });

  it('getPlan: returns null when not found', () => {
    const result = repo.getPlan('nonexistent');
    expect(result).toBeNull();
  });

  it('getPlan: returns full plan with all steps in correct order', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'running', current_step_index: 1, replan_count: 0,
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0 },
        { id: 's2', description: 'B', status: 'running', retries: 0 },
        { id: 's3', description: 'C', status: 'pending', retries: 0 },
      ],
    });

    const loaded = repo.getPlan('p1');
    expect(loaded).not.toBeNull();
    expect(loaded!.steps).toHaveLength(3);
    expect(loaded!.steps.map(s => s.description)).toEqual(['A', 'B', 'C']);
    expect(loaded!.current_step_index).toBe(1);
  });

  it('updatePlanStatus: changes status and updated_at', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'draft', current_step_index: 0, replan_count: 0,
      steps: [{ id: 's1', description: 'A', status: 'pending', retries: 0 }],
    });

    const before = Date.now();
    repo.updatePlanStatus('p1', 'running');
    const after = Date.now();

    const loaded = repo.getPlan('p1');
    expect(loaded!.status).toBe('running');
    expect(loaded!.updated_at).toBeGreaterThanOrEqual(before);
    expect(loaded!.updated_at).toBeLessThanOrEqual(after);
  });

  it('updatePlanStatus: accepts all valid statuses', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'draft', current_step_index: 0, replan_count: 0,
      steps: [{ id: 's1', description: 'A', status: 'pending', retries: 0 }],
    });

    const statuses: PlanStatus[] = ['draft', 'running', 'paused', 'completed', 'aborted'];
    for (const s of statuses) {
      repo.updatePlanStatus('p1', s);
      expect(repo.getPlan('p1')!.status).toBe(s);
    }
  });

  it('updateStep: mutates a single step', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'running', current_step_index: 0, replan_count: 0,
      steps: [{ id: 's1', description: 'A', status: 'pending', retries: 0 }],
    });

    repo.updateStep('s1', {
      status: 'completed',
      result: 'did the thing',
      completed_at: now + 100,
    });

    const loaded = repo.getPlan('p1');
    expect(loaded!.steps[0].status).toBe('completed');
    expect(loaded!.steps[0].result).toBe('did the thing');
    expect(loaded!.steps[0].completed_at).toBe(now + 100);
  });

  it('updateStep: increments retries atomically', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'running', current_step_index: 0, replan_count: 0,
      steps: [{ id: 's1', description: 'A', status: 'failed', retries: 0 }],
    });

    repo.incrementStepRetries('s1');
    repo.incrementStepRetries('s1');

    const loaded = repo.getPlan('p1');
    expect(loaded!.steps[0].retries).toBe(2);
  });

  it('incrementReplanCount: bumps replan_count and returns new value', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'running', current_step_index: 0, replan_count: 0,
      steps: [{ id: 's1', description: 'A', status: 'pending', retries: 0 }],
    });

    expect(repo.incrementReplanCount('p1')).toBe(1);
    expect(repo.incrementReplanCount('p1')).toBe(2);
    expect(repo.getPlan('p1')!.replan_count).toBe(2);
  });

  it('replacePlanSteps: deletes old steps, inserts new (replan use case)', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'running', current_step_index: 0, replan_count: 0,
      steps: [
        { id: 's1', description: 'A', status: 'completed', retries: 0 },
        { id: 's2', description: 'B', status: 'failed', retries: 3 },
      ],
    });

    const newSteps: PlanStep[] = [
      { id: 's1', description: 'A', status: 'completed', retries: 0 },
      { id: 's-new', description: 'B-v2', status: 'pending', retries: 0 },
    ];
    repo.replacePlanSteps('p1', newSteps);

    const loaded = repo.getPlan('p1');
    expect(loaded!.steps).toHaveLength(2);
    expect(loaded!.steps[1].description).toBe('B-v2');
  });

  it('listPlansByGoal: returns all plans for a goal', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'draft', current_step_index: 0, replan_count: 0,
      steps: [{ id: 's1', description: 'A', status: 'pending', retries: 0 }],
    });
    repo.createPlan({
      id: 'p2', goal_id: 'g1', created_at: now + 1, updated_at: now + 1,
      status: 'draft', current_step_index: 0, replan_count: 0,
      steps: [{ id: 's2', description: 'B', status: 'pending', retries: 0 }],
    });
    repo.createPlan({
      id: 'p3', goal_id: 'g2', created_at: now + 2, updated_at: now + 2,
      status: 'draft', current_step_index: 0, replan_count: 0,
      steps: [{ id: 's3', description: 'C', status: 'pending', retries: 0 }],
    });

    const g1Plans = repo.listPlansByGoal('g1');
    expect(g1Plans).toHaveLength(2);
    expect(g1Plans.map(p => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('preserves step acceptance as JSON', () => {
    const now = Date.now();
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'draft', current_step_index: 0, replan_count: 0,
      steps: [{
        id: 's1', description: 'A', status: 'pending', retries: 0,
        acceptance: ['sub-1', 'sub-2'],
      }],
    });

    const loaded = repo.getPlan('p1');
    expect(loaded!.steps[0].acceptance).toEqual(['sub-1', 'sub-2']);
  });

  it('preserves all step statuses', () => {
    const now = Date.now();
    const statuses: StepStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped'];
    repo.createPlan({
      id: 'p1', goal_id: 'g1', created_at: now, updated_at: now,
      status: 'running', current_step_index: 0, replan_count: 0,
      steps: statuses.map((s, i) => ({
        id: `s${i}`, description: `step-${i}`, status: s, retries: 0,
      })),
    });

    const loaded = repo.getPlan('p1');
    expect(loaded!.steps.map(s => s.status)).toEqual(statuses);
  });
});