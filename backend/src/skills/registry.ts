/**
 * 技能注册表 — 启动时扫 ~/.lingshu/skills/,加载 manifest.json,校验必填字段
 *
 * 校验失败 → 抛错(启动失败)。Skill 加载失败 = 数据腐败,不能静默吞。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SkillDefinition } from './types.js';

export async function loadSkills(skillsDir: string): Promise<SkillDefinition[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const skills: SkillDefinition[] = [];
  for (const entry of entries) {
    const manifestPath = path.join(skillsDir, entry, 'manifest.json');
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf-8');
    } catch {
      continue;
    }
    const manifest = JSON.parse(raw);
    validateSkill(manifest, entry);
    skills.push(manifest);
  }
  return skills;
}

function validateSkill(m: any, dirname: string): asserts m is SkillDefinition {
  if (!m || typeof m !== 'object') throw new Error(`Skill "${dirname}" manifest is not an object`);
  if (!m.name || typeof m.name !== 'string') throw new Error(`Skill "${dirname}" missing name`);
  if (!m.displayName?.trim()) throw new Error(`Skill "${dirname}" missing displayName (中文展示名)`);
  if (!m.description?.trim()) throw new Error(`Skill "${dirname}" missing description (中文描述)`);
  if (!m.version) throw new Error(`Skill "${dirname}" missing version`);
  if (!m.lingshuMinVersion) throw new Error(`Skill "${dirname}" missing lingshuMinVersion`);
}

/**
 * 解析并校验一个外部输入为 SkillDefinition。
 * 由 storage.saveSkill / installer / IPC 调用,在写入磁盘前捕获错误。
 */
export function parseSkillDefinition(input: unknown, fallbackName = 'skill'): SkillDefinition {
  if (!input || typeof input !== 'object') {
    throw new Error(`Skill manifest must be an object (got ${typeof input})`);
  }
  const m = { ...(input as Record<string, unknown>) };
  if (!m.name || typeof m.name !== 'string') m.name = fallbackName;
  // 复用同一套必填校验,沿用中文错误文案
  validateSkill(m, m.name as string);
  return m as SkillDefinition;
}
