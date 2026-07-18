import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { bootSkills, SkillsBootError, defaultSkillsDir } from './boot.js';

let tmpDir: string;
const logMock = vi.fn();
const logErrorMock = vi.fn();

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-skills-boot-'));
  logMock.mockClear();
  logErrorMock.mockClear();
});
afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

async function writeSkill(dirName: string, manifest: any) {
  const skillDir = path.join(tmpDir, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
}

describe('bootSkills (Spec 1 C4)', () => {
  it('loads valid skills from skillsDir and logs count', async () => {
    await writeSkill('weather-lookup', {
      name: 'weather-lookup',
      displayName: '天气查询',
      description: '查指定城市的实时天气',
      version: '1.0.0',
      lingshuMinVersion: '2.0.0',
    });
    const skills = await bootSkills({ skillsDir: tmpDir, log: logMock, logError: logErrorMock });
    expect(skills).toHaveLength(1);
    expect(skills[0].displayName).toBe('天气查询');
    expect(logMock).toHaveBeenCalledTimes(1);
    const logLine = logMock.mock.calls[0][0];
    expect(logLine).toContain('Loaded 1 skill');
    expect(logLine).toContain('天气查询');
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('returns empty array and logs zero when skillsDir does not exist (ENOENT is treated as empty)', async () => {
    const missingDir = path.join(tmpDir, 'no-such-dir');
    const skills = await bootSkills({ skillsDir: missingDir, log: logMock, logError: logErrorMock });
    expect(skills).toHaveLength(0);
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock.mock.calls[0][0]).toContain('Loaded 0 skill');
  });

  it('throws SkillsBootError when a skill manifest is invalid (missing displayName)', async () => {
    await writeSkill('bad-skill', {
      name: 'bad-skill',
      description: 'desc',
      version: '1.0.0',
      lingshuMinVersion: '2.0.0',
    });
    await expect(
      bootSkills({ skillsDir: tmpDir, log: logMock, logError: logErrorMock })
    ).rejects.toBeInstanceOf(SkillsBootError);
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock.mock.calls[0][0]).toContain('displayName');
  });

  it('throws SkillsBootError when a skill manifest has malformed JSON', async () => {
    const skillDir = path.join(tmpDir, 'broken');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'manifest.json'), '{ not valid json', 'utf-8');
    await expect(
      bootSkills({ skillsDir: tmpDir, log: logMock, logError: logErrorMock })
    ).rejects.toBeInstanceOf(SkillsBootError);
  });

  it('loads multiple valid skills and joins displayNames in log line', async () => {
    await writeSkill('a', { name: 'a', displayName: '技能A', description: 'd', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    await writeSkill('b', { name: 'b', displayName: '技能B', description: 'd', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    const skills = await bootSkills({ skillsDir: tmpDir, log: logMock, logError: logErrorMock });
    expect(skills).toHaveLength(2);
    expect(logMock.mock.calls[0][0]).toContain('Loaded 2 skill');
    expect(logMock.mock.calls[0][0]).toContain('技能A');
    expect(logMock.mock.calls[0][0]).toContain('技能B');
  });

  it('defaultSkillsDir() returns ~/.lingshu/skills', () => {
    const dir = defaultSkillsDir();
    expect(dir).toMatch(/[\\/]\.lingshu[\\/]skills$/);
  });
});