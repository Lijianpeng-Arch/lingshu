import { describe, it, expect } from 'vitest';
import { evaluate } from './gate';
import type { PermissionRequest, ToolDescriptor } from './types';

const td = (risk: ToolDescriptor['risk']): ToolDescriptor => ({
  name: 'test',
  displayName: '测试',
  displayDescription: '测试',
  risk,
});

const make = (mode: PermissionRequest['mode'], risk: ToolDescriptor['risk'], rules: PermissionRequest['rules'] = []): PermissionRequest => ({
  tool: 'delete_file',
  args: { path: '~/Desktop/foo.txt' },
  mode,
  rules,
  toolDescriptor: td(risk),
});

// ---- I3 Spec 2A: alias scanning (cmd/exec/shell/bash) ----
// Borrowed from OpenCode permission/evaluate.ts parameter normalization.

describe('alias scanning (I3)', () => {
  it('run_command with args.cmd="shutdown -h now" hits deny rule', () => {
    const d = evaluate({
      tool: 'run_command',
      args: { cmd: 'shutdown -h now' },
      mode: 'autonomous',
      rules: [{ permission: 'run_command', pattern: '*shutdown*', action: 'deny' }],
      toolDescriptor: td('high'),
    });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('run_command');
  });

  it('run_command with args.exec="rm -rf /" hits deny rule', () => {
    const d = evaluate({
      tool: 'run_command',
      args: { exec: 'rm -rf /' },
      mode: 'autonomous',
      rules: [{ permission: 'run_command', pattern: '**rm**', action: 'deny' }],
      toolDescriptor: td('high'),
    });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('run_command');
  });

  it('run_command with args.shell="mkfs /dev/sda" hits deny rule', () => {
    const d = evaluate({
      tool: 'run_command',
      args: { shell: 'mkfs /dev/sda' },
      mode: 'autonomous',
      rules: [{ permission: 'run_command', pattern: '**mkfs**', action: 'deny' }],
      toolDescriptor: td('high'),
    });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('run_command');
  });

  it('run_command with args.command="shutdown" (canonical) STILL hits deny rule (regression)', () => {
    // Make sure we didn't break the canonical key path.
    const d = evaluate({
      tool: 'run_command',
      args: { command: 'shutdown -h now' },
      mode: 'autonomous',
      rules: [{ permission: 'run_command', pattern: '*shutdown*', action: 'deny' }],
      toolDescriptor: td('high'),
    });
    expect(d.kind).toBe('deny');
  });
});

describe('evaluate', () => {
  describe('mode: smart', () => {
    it('low risk → allow', () => expect(evaluate(make('smart', 'low')).kind).toBe('allow'));
    it('medium risk → ask', () => expect(evaluate(make('smart', 'medium')).kind).toBe('ask'));
    it('high risk → ask', () => expect(evaluate(make('smart', 'high')).kind).toBe('ask'));
  });

  describe('mode: autonomous', () => {
    it('high risk → ask (H2: no longer auto-allowed)', () => expect(evaluate(make('autonomous', 'high')).kind).toBe('ask'));
    it('low risk → allow', () => expect(evaluate(make('autonomous', 'low')).kind).toBe('allow'));
    it('medium risk → allow', () => expect(evaluate(make('autonomous', 'medium')).kind).toBe('allow'));
  });

  describe('mode: step', () => {
    it('low risk → ask', () => expect(evaluate(make('step', 'low')).kind).toBe('ask'));
  });

  describe('mode: goal', () => {
    it('low risk → allow', () => expect(evaluate(make('goal', 'low')).kind).toBe('allow'));
    it('high risk → ask (even in goal mode)', () => expect(evaluate(make('goal', 'high')).kind).toBe('ask'));
  });

  describe('mode: plan', () => {
    it('low risk → ask', () => expect(evaluate(make('plan', 'low')).kind).toBe('ask'));
  });

  describe('rule override', () => {
    it('deny rule beats mode default', () => {
      const d = evaluate(make('autonomous', 'low', [{ permission: 'delete_file', pattern: '~/Desktop/**', action: 'deny' }]));
      expect(d.kind).toBe('deny');
    });
    it('allow rule beats ask mode', () => {
      const d = evaluate(make('smart', 'high', [{ permission: 'delete_file', pattern: '~/Desktop/**', action: 'allow' }]));
      expect(d.kind).toBe('allow');
    });
  });

  describe('built-in deny (cannot be overridden by allow rules)', () => {
    it('denies git_commit when message contains "push" (even in autonomous mode)', () => {
      const d = evaluate({
        tool: 'git_commit',
        args: { message: 'push to origin' },
        mode: 'autonomous',
        rules: [{ permission: 'git_commit', pattern: '*', action: 'allow' }],
        toolDescriptor: td('high'),
      });
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toContain('forbids push');
    });

    it('denies git_commit when message contains "push" case-insensitively', () => {
      const d = evaluate({
        tool: 'git_commit',
        args: { message: 'PUSH latest changes' },
        mode: 'autonomous',
        rules: [],
        toolDescriptor: td('high'),
      });
      expect(d.kind).toBe('deny');
    });

    it('autonomous + git_commit (high risk) → ask (H2: autonomous no longer auto-allows high-risk)', () => {
      const d = evaluate({
        tool: 'git_commit',
        args: { message: 'fix: clean up unused imports' },
        mode: 'autonomous',
        rules: [],
        toolDescriptor: td('high'),
      });
      expect(d.kind).toBe('ask');
    });
  });
});
