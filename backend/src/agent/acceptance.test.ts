/**
 * acceptance.ts 测试 — parseAcceptance + allPassed
 * 灵枢 V2 — Goal 系统核心数据结构
 */

import { describe, it, expect } from 'vitest';
import { parseAcceptance, allPassed, type AcceptanceCriterion } from './acceptance.js';

describe('parseAcceptance', () => {
  it('parses numbered list "1) xxx\\n2) yyy"', () => {
    const result = parseAcceptance('1) 测试全绿\n2) 新增 commit');
    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe('测试全绿');
    expect(result[1]?.text).toBe('新增 commit');
  });

  it('parses dash list "- xxx\\n- yyy"', () => {
    const result = parseAcceptance('- 第一项\n- 第二项');
    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe('第一项');
    expect(result[1]?.text).toBe('第二项');
  });

  it('parses asterisk list "* xxx\\n* yyy"', () => {
    const result = parseAcceptance('* foo\n* bar');
    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe('foo');
    expect(result[1]?.text).toBe('bar');
  });

  it('returns empty array for empty input', () => {
    expect(parseAcceptance('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseAcceptance('   \n  \n')).toEqual([]);
  });

  it('filters out blank lines between items', () => {
    const result = parseAcceptance('1) a\n\n2) b\n\n3) c');
    expect(result).toHaveLength(3);
    expect(result[0]?.text).toBe('a');
    expect(result[1]?.text).toBe('b');
    expect(result[2]?.text).toBe('c');
  });

  it('preserves passed/evidence as undefined on parse', () => {
    const result = parseAcceptance('1) 只测文本');
    expect(result[0]?.passed).toBeUndefined();
    expect(result[0]?.evidence).toBeUndefined();
  });

  it('handles mixed list markers (number + dash)', () => {
    const result = parseAcceptance('1) a\n- b');
    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe('a');
    expect(result[1]?.text).toBe('b');
  });

  it('returns AcceptanceCriterion objects (not raw strings)', () => {
    const result = parseAcceptance('1) foo');
    expect(result[0]).toEqual({ text: 'foo' });
  });
});

describe('allPassed', () => {
  it('true when all criteria have passed=true', () => {
    const criteria: AcceptanceCriterion[] = [
      { text: 'a', passed: true },
      { text: 'b', passed: true },
    ];
    expect(allPassed(criteria)).toBe(true);
  });

  it('false when any criterion has passed=false', () => {
    const criteria: AcceptanceCriterion[] = [
      { text: 'a', passed: true },
      { text: 'b', passed: false },
    ];
    expect(allPassed(criteria)).toBe(false);
  });

  it('false when any criterion has passed=undefined', () => {
    const criteria: AcceptanceCriterion[] = [
      { text: 'a', passed: true },
      { text: 'b' },
    ];
    expect(allPassed(criteria)).toBe(false);
  });

  it('true for empty criteria array (vacuously true)', () => {
    expect(allPassed([])).toBe(true);
  });

  it('false when all criteria have passed=false', () => {
    const criteria: AcceptanceCriterion[] = [
      { text: 'a', passed: false },
      { text: 'b', passed: false },
    ];
    expect(allPassed(criteria)).toBe(false);
  });

  it('does not mutate the input array', () => {
    const criteria: AcceptanceCriterion[] = [
      { text: 'a', passed: true },
      { text: 'b', passed: false },
    ];
    const before = JSON.stringify(criteria);
    allPassed(criteria);
    expect(JSON.stringify(criteria)).toBe(before);
  });
});