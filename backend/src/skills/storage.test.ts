import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listStoredSkills, saveSkill, SkillStorageError } from './storage.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-storage-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const sample = {
  name: 'weather-query',
  displayName: '天气查询',
  description: '查询天气',
  version: '1.0.0',
  lingshuMinVersion: '2.0.0',
  dependencies: [],
  prompt: '查询天气',
  triggers: ['天气'],
};

describe('saveSkill / listStoredSkills (Spec 1 C2)', () => {
  it('atomically saves and reloads a complete skill', async () => {
    await saveSkill(sample, tmpDir);
    expect(await listStoredSkills(tmpDir)).toEqual([sample]);
    const manifest = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'weather-query', 'manifest.json'), 'utf8'),
    );
    expect(manifest.prompt).toBe('查询天气');
    expect(manifest.triggers).toEqual(['天气']);
  });

  it('refuses to overwrite an installed skill', async () => {
    await saveSkill(sample, tmpDir);
    await expect(saveSkill(sample, tmpDir)).rejects.toMatchObject({
      code: 'already_exists',
    } satisfies Partial<SkillStorageError>);
  });
});