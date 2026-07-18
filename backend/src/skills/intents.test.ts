import { describe, it, expect } from 'vitest';
import { detectSkillCreationIntent } from './intents.js';

describe('detectSkillCreationIntent', () => {
  it('matches "帮我做个天气技能"', () => {
    const r = detectSkillCreationIntent('帮我做个天气技能');
    expect(r.intent).toBe('create_skill');
    expect(r.subject).toContain('天气');
  });

  it('matches "做个查询 GitHub 的技能"', () => {
    const r = detectSkillCreationIntent('帮我做个查询 GitHub 的技能');
    expect(r.intent).toBe('create_skill');
    expect(r.subject).toContain('GitHub');
  });

  it('matches "我想新建一个技能"', () => {
    const r = detectSkillCreationIntent('我想新建一个技能');
    expect(r.intent).toBe('create_skill');
  });

  it('returns null for normal message', () => {
    const r = detectSkillCreationIntent('今天天气怎么样');
    expect(r.intent).toBeNull();
  });

  it('handles empty string', () => {
    const r = detectSkillCreationIntent('');
    expect(r.intent).toBeNull();
  });
});
