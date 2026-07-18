import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSkillsDir } from './paths.js';

describe('defaultSkillsDir (Spec 1 C4)', () => {
  it('uses LINGSHU_SKILLS_DIR override', () => {
    expect(defaultSkillsDir({ LINGSHU_SKILLS_DIR: 'D:/temp/skills' })).toBe(path.resolve('D:/temp/skills'));
  });

  it('falls back to the user skill directory', () => {
    expect(defaultSkillsDir({})).toMatch(/[\\/]\.lingshu[\\/]skills$/);
  });
});