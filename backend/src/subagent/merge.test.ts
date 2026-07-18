/**
 * Merge 测试 — Spec 2C-2
 */

import { describe, it, expect } from 'vitest';
import {
  mergeResults,
  allOk,
  anyOk,
  countOk,
  totalToolCalls,
  totalDuration,
  maxDuration,
} from './merge.js';
import type { SubAgentResult } from './types.js';

function ok(task_id: string, output: string, ms = 10): SubAgentResult {
  return { task_id, ok: true, output, tool_calls: [], duration_ms: ms, status: 'completed' };
}
function fail(task_id: string, err: string, status: 'failed' | 'timeout' = 'failed', ms = 5): SubAgentResult {
  return { task_id, ok: false, error: err, tool_calls: [], duration_ms: ms, status };
}

describe('mergeResults', () => {
  it('joins multiple ok results with separator', () => {
    const merged = mergeResults([ok('t1', 'first'), ok('t2', 'second')]);
    expect(merged).toContain('[t1]');
    expect(merged).toContain('first');
    expect(merged).toContain('[t2]');
    expect(merged).toContain('second');
    expect(merged).toContain('---');
  });

  it('marks failed results with prefix (no throw)', () => {
    const merged = mergeResults([ok('t1', 'ok'), fail('t2', 'bad')]);
    expect(merged).toContain('[t1]');
    expect(merged).toContain('[t2]');
    expect(merged).toContain('bad');
    expect(merged).toContain('failed');
  });

  it('handles empty result list', () => {
    const merged = mergeResults([]);
    expect(merged).toBe('');
  });

  it('respects custom separator', () => {
    const merged = mergeResults([ok('t1', 'a'), ok('t2', 'b')], { separator: '|||' });
    expect(merged).toContain('|||');
    expect(merged).not.toContain('---');
  });

  it('includes tool summary when enabled', () => {
    const result: SubAgentResult = {
      task_id: 't1',
      ok: true,
      output: 'done',
      tool_calls: [
        { tool: 'read_file', args: {}, started_at: 1, completed_at: 2 },
        { tool: 'grep', args: {}, started_at: 3, completed_at: 4 },
      ],
      duration_ms: 10,
      status: 'completed',
    };
    const merged = mergeResults([result], { includeToolSummary: true });
    expect(merged).toContain('tools: read_file, grep');
  });
});

describe('merge helpers', () => {
  it('allOk true iff every result is ok', () => {
    expect(allOk([ok('t1', 'x'), ok('t2', 'y')])).toBe(true);
    expect(allOk([ok('t1', 'x'), fail('t2', 'x')])).toBe(false);
    expect(allOk([])).toBe(false);  // 空列表视为不 ok (无成功)
  });

  it('anyOk true if at least one ok', () => {
    expect(anyOk([fail('t1', 'x'), ok('t2', 'y')])).toBe(true);
    expect(anyOk([fail('t1', 'x'), fail('t2', 'y')])).toBe(false);
    expect(anyOk([])).toBe(false);
  });

  it('countOk counts only ok', () => {
    expect(countOk([ok('t1', 'x'), ok('t2', 'y'), fail('t3', 'z')])).toBe(2);
    expect(countOk([])).toBe(0);
  });

  it('totalToolCalls sums tool_calls', () => {
    const r1: SubAgentResult = { ...ok('t1', 'x'), tool_calls: [{ tool: 'a', args: {}, started_at: 1 }, { tool: 'b', args: {}, started_at: 2 }] };
    const r2: SubAgentResult = { ...ok('t2', 'y'), tool_calls: [{ tool: 'c', args: {}, started_at: 3 }] };
    expect(totalToolCalls([r1, r2])).toBe(3);
  });

  it('totalDuration sums durations', () => {
    expect(totalDuration([ok('t1', 'x', 10), ok('t2', 'y', 20)])).toBe(30);
  });

  it('maxDuration returns longest (used for parallel verification)', () => {
    expect(maxDuration([ok('t1', 'x', 100), ok('t2', 'y', 50), ok('t3', 'z', 200)])).toBe(200);
  });
});