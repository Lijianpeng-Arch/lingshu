/**
 * 技能导出 — 把技能打包成 .skill 文件(zip + manifest.json + tools/ + config.schema.json? + readme)
 *
 * Spec 1 只做导出端,导入端给 Spec 3。文件结构跟 Spec 3 市场条目同构。
 *
 * 设计要点:
 *   - buildManifest / buildZip 拆出来共享,确保 main process export 与 wizard 一致
 *   - README 含触发词与基础字段,纯中文
 *   - configSchema(若有)走 config.schema.json 单独文件,manifest 里不放冗余副本
 */

import JSZip from 'jszip';
import * as fs from 'node:fs/promises';
import type { SkillDefinition } from '@lingshu/shared-types';

export const SKILL_PACKAGE_VERSION = '1';

export interface SkillPackageInput {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author?: string;
  lingshuMinVersion?: string;
  /** manifest 不存 configSchema;单独写到 config.schema.json */
  configSchema?: Record<string, unknown>;
  /** prompt(可选)—— Spec 1 C6: 写进 manifest 让导入端能还原 */
  prompt?: string;
  /** 触发词列表(可选)—— Spec 1 C6: 写进 manifest */
  triggers?: string[];
}

/**
 * 拼装 manifest.json 字段。注意 configSchema/prompt/triggers 属于可选附加字段,
 * undefined / 空数组 / 空字符串 都不会被序列化进 manifest。
 */
export function buildManifest(skill: SkillPackageInput): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    version: skill.version,
    lingshuMinVersion: skill.lingshuMinVersion ?? '2.0.0',
    packageVersion: SKILL_PACKAGE_VERSION,
  };
  if (skill.author && skill.author.trim()) manifest.author = skill.author.trim();
  if (skill.prompt && skill.prompt.trim()) manifest.prompt = skill.prompt.trim();
  if (Array.isArray(skill.triggers) && skill.triggers.length > 0) manifest.triggers = skill.triggers;
  // 注意:configSchema 不写进 manifest,单独写 config.schema.json
  return manifest;
}

export function generateReadme(skill: SkillPackageInput): string {
  const triggers = Array.isArray(skill.triggers) && skill.triggers.length > 0
    ? skill.triggers.join('、')
    : '(未设置)';
  return `# ${skill.displayName}

${skill.description}

**版本**: ${skill.version}
**作者**: ${skill.author?.trim() || '匿名'}
**兼容灵枢版本**: >= ${skill.lingshuMinVersion ?? '2.0.0'}

## 触发词

${triggers}

## 使用方法

在灵枢里说"${skill.displayName}"或触发关键词即可。
`;
}

/**
 * 把 skill 打成 zip buffer(供 main process 写到用户选定路径)。
 *   - manifest.json
 *   - tools/ (空目录占位,真实工具定义后续 spec 接入)
 *   - config.schema.json (如有)
 *   - README.md
 */
export async function buildZip(skill: SkillPackageInput): Promise<Buffer> {
  const zip = new JSZip();
  const manifest = buildManifest(skill);
  zip.file('manifest.json', JSON.stringify(manifest, null, 2), { date: new Date('2024-01-01') });
  zip.folder('tools');
  if (skill.configSchema && Object.keys(skill.configSchema).length > 0) {
    zip.file('config.schema.json', JSON.stringify(skill.configSchema, null, 2));
  }
  zip.file('README.md', generateReadme(skill));
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  });
}

/**
 * 导出 entry:把 WizardSkill (UI 端类型) 写成 .skill 文件。
 * 接受 SkillDefinition 也接受 WizardSkill,因为二者同构。
 */
export async function exportSkill(
  skill: SkillDefinition,
  savePath: string,
): Promise<void> {
  const buffer = await buildZip(skill as SkillPackageInput);
  await fs.writeFile(savePath, buffer);
}

/** 兼容旧 API — 直接返回 zip buffer */
export async function generateSkillPackage(skill: SkillDefinition): Promise<Buffer> {
  return buildZip(skill as SkillPackageInput);
}
