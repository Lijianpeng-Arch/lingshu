/**
 * 技能存储 — Spec 4 设计的最小实现。仅供 Task 7 在 routes.ts / server.ts 调用。
 *
 * - listStoredSkills: 读 ~/.lingshu/skills/,parse 每个 manifest.json,使用 SkillDefinitionSchema 校验 + normalize。
 * - saveSkill: 原子 staging + rename,拒绝覆盖,缺中文字段则抛中文错(走 registry.parseSkillDefinition)。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { defaultSkillsDir } from './paths.js';
import { loadSkills, parseSkillDefinition } from './registry.js';
import type { SkillDefinition } from './types.js';

export class SkillStorageError extends Error {
  constructor(public readonly code: 'already_exists' | 'write_failed', message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SkillStorageError';
  }
}

export async function listStoredSkills(skillsDir = defaultSkillsDir()): Promise<SkillDefinition[]> {
  const skills = await loadSkills(skillsDir);
  console.log(`[storage] listStoredSkills: dir=${skillsDir} count=${skills.length}`);
  return skills;
}

export async function saveSkill(input: unknown, skillsDir = defaultSkillsDir()): Promise<SkillDefinition> {
  const skill = parseSkillDefinition(input, '新技能');
  await fs.mkdir(skillsDir, { recursive: true });
  const target = path.join(skillsDir, skill.name);
  const staging = path.join(skillsDir, `.install-${randomUUID()}`);
  console.log(`[storage] saveSkill: target=${target} skillsDir=${skillsDir} skillName=${skill.name}`);
  try {
    await fs.access(target);
    throw new SkillStorageError('already_exists', '这个技能已经存在，请换一个内部标识');
  } catch (err) {
    if (err instanceof SkillStorageError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await fs.mkdir(staging);
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(skill, null, 2), 'utf8');
    await fs.rename(staging, target);
    return skill;
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new SkillStorageError('write_failed', '保存技能失败，请检查目录权限', err);
  }
}
