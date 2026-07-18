import { describe, it, expect } from 'vitest';
import {
  MemoryScopeSchema,
  ThoughtKindSchema,
  TaskStatusSchema,
  ReminderStatusSchema,
} from './types.js';

describe('memory Zod schemas', () => {
  it('accepts all legal values for the 4 schemas', () => {
    expect(MemoryScopeSchema.parse('short')).toBe('short');
    expect(MemoryScopeSchema.parse('long')).toBe('long');
    expect(MemoryScopeSchema.parse('profile')).toBe('profile');
    expect(MemoryScopeSchema.parse('task')).toBe('task');
    expect(MemoryScopeSchema.parse('media')).toBe('media');

    expect(ThoughtKindSchema.parse('observation')).toBe('observation');
    expect(ThoughtKindSchema.parse('inference')).toBe('inference');
    expect(ThoughtKindSchema.parse('plan')).toBe('plan');
    expect(ThoughtKindSchema.parse('question')).toBe('question');
    expect(ThoughtKindSchema.parse('decision')).toBe('decision');

    expect(TaskStatusSchema.parse('pending')).toBe('pending');
    expect(TaskStatusSchema.parse('active')).toBe('active');
    expect(TaskStatusSchema.parse('done')).toBe('done');
    expect(TaskStatusSchema.parse('failed')).toBe('failed');
    expect(TaskStatusSchema.parse('cancelled')).toBe('cancelled');

    expect(ReminderStatusSchema.parse('pending')).toBe('pending');
    expect(ReminderStatusSchema.parse('fired')).toBe('fired');
    expect(ReminderStatusSchema.parse('dismissed')).toBe('dismissed');
  });

  it('rejects illegal values for the 4 schemas', () => {
    expect(() => MemoryScopeSchema.parse('forever')).toThrow();
    expect(() => MemoryScopeSchema.parse('')).toThrow();

    expect(() => ThoughtKindSchema.parse('guess')).toThrow();
    expect(() => ThoughtKindSchema.parse('DECISION')).toThrow(); // case-sensitive

    expect(() => TaskStatusSchema.parse('in-progress')).toThrow();
    expect(() => TaskStatusSchema.parse('Done')).toThrow();

    expect(() => ReminderStatusSchema.parse('skipped')).toThrow();
    expect(() => ReminderStatusSchema.parse('Fired')).toThrow();
  });
});