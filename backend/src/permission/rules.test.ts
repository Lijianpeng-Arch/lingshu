import { describe, it, expect } from 'vitest';
import { findMatchingRule } from './rules';
import type { Rule } from './types';

describe('findMatchingRule', () => {
  const rules: Rule[] = [
    { permission: 'Read(~/Documents/**)', pattern: '~/Documents/**', action: 'allow' },
    { permission: 'Bash(rm:*)', pattern: 'rm *', action: 'deny' },
    { permission: 'Write(~/Desktop/**)', pattern: '~/Desktop/**', action: 'ask' },
  ];

  it('matches allow rule for ~/Documents/foo.txt', () => {
    const r = findMatchingRule(rules, 'Read', '~/Documents/foo.txt');
    expect(r?.action).toBe('allow');
  });

  it('matches deny rule for rm command', () => {
    const r = findMatchingRule(rules, 'Bash', 'rm -rf tmp');
    expect(r?.action).toBe('deny');
  });

  it('returns undefined when no rule matches', () => {
    const r = findMatchingRule(rules, 'Write', '~/Other/foo.txt');
    expect(r).toBeUndefined();
  });

  it('first matching rule wins (deny priority)', () => {
    const conflicting: Rule[] = [
      { permission: 'Read(**)', pattern: '**', action: 'allow' },
      { permission: 'Bash(*)', pattern: '*', action: 'deny' },
    ];
    const r = findMatchingRule(conflicting, 'Bash', 'rm foo');
    expect(r?.action).toBe('deny');
  });
});