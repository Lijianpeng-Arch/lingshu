import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSkills } from './registry.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-skills-'));
});
afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

async function writeSkill(dirName: string, manifest: any) {
  const skillDir = path.join(tmpDir, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
}

describe('loadSkills', () => {
  it('loads valid skill', async () => {
    await writeSkill('weather-lookup', {
      name: 'weather-lookup',
      displayName: '天气查询',
      description: '查指定城市的实时天气',
      version: '1.0.0',
      lingshuMinVersion: '2.0.0',
    });
    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].displayName).toBe('天气查询');
  });
  it('skips skill without displayName', async () => {
    await writeSkill('bad1', { name: 'bad1', description: 'desc', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    await expect(loadSkills(tmpDir)).rejects.toThrow(/displayName/);
  });
  it('skips skill without description', async () => {
    await writeSkill('bad2', { name: 'bad2', displayName: '显示', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    await expect(loadSkills(tmpDir)).rejects.toThrow(/description/);
  });
  it('loads multiple skills', async () => {
    await writeSkill('a', { name: 'a', displayName: 'A', description: 'd', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    await writeSkill('b', { name: 'b', displayName: 'B', description: 'd', version: '1.0.0', lingshuMinVersion: '2.0.0' });
    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(2);
  });
});
