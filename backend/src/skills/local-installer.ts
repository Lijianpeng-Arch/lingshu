import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Provider } from '../providers/types.js';
import { SkillTranslationError, translateSkill } from './translator.js';
import { parseSkillDefinition } from './registry.js';
import { defaultSkillsDir } from './paths.js';
import type { SkillDefinition } from './types.js';

export interface LocalSkillInspection {
  sourceDir: string;
  name: string;
  displayName?: string;
  description?: string;
  needsChinese: boolean;
}

export type LocalizationChoice =
  | { mode: 'keep' }
  | { mode: 'manual'; displayName: string; description: string };

export type LocalSkillInstallResult =
  | { ok: true; skill: SkillDefinition }
  | { ok: false; message: string };

export type TranslationPreviewResult =
  | { ok: true; displayName: string; description: string }
  | { ok: false; needsManual: true; message: string };

export interface TranslationPreviewOptions {
  sourceDir: string;
  provider?: Pick<Provider, 'chatStream'>;
}

export interface InstallOptions {
  sourceDir: string;
  choice: LocalizationChoice;
  skillsDir?: string;
}

function resolveNonEmpty(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('技能目录不能为空');
  return path.resolve(input);
}

export async function inspectLocalSkill(sourceDir: string): Promise<LocalSkillInspection> {
  const resolved = resolveNonEmpty(sourceDir);
  const manifestPath = path.join(resolved, 'manifest.json');
  let raw: string;
  try { raw = await fs.readFile(manifestPath, 'utf8'); } catch { throw new Error('找不到 manifest.json，请选择已解包的技能目录'); }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('manifest.json 格式错误'); }
  const name = String(manifest.name ?? '');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('技能内部标识格式错误');
  if (!String(manifest.version ?? '').trim() || !String(manifest.lingshuMinVersion ?? '').trim()) throw new Error('技能缺少版本信息');
  const displayName = String(manifest.displayName ?? '').trim() || undefined;
  const description = String(manifest.description ?? '').trim() || undefined;
  return { sourceDir: resolved, name, displayName, description, needsChinese: !displayName || !description };
}

export async function previewLocalSkillTranslation(options: TranslationPreviewOptions): Promise<TranslationPreviewResult> {
  const inspection = await inspectLocalSkill(options.sourceDir);
  if (!inspection.needsChinese) return { ok: true, displayName: inspection.displayName!, description: inspection.description! };
  if (!options.provider) return { ok: false, needsManual: true, message: '自动翻译暂时不可用，请手动填写中文信息' };
  try {
    const translated = await translateSkill({ name: inspection.name, displayName: inspection.displayName, description: inspection.description }, options.provider);
    return { ok: true, displayName: translated.displayName, description: translated.description };
  } catch (err) {
    if (err instanceof SkillTranslationError) {
      // 按细分错误码给出不同中文提示,均降级到手填模式(不改返回结构)
      const message =
        err.code === 'empty'
          ? '模型返回为空，请手动填写中文信息'
          : err.code === 'malformed'
            ? '模型输出异常，请手动填写中文信息'
            : '自动翻译暂时不可用，请手动填写中文信息';
      return { ok: false, needsManual: true, message };
    }
    throw err;
  }
}

async function copySkillDirectoryAtomically(sourceDir: string, name: string, skillsDir: string): Promise<void> {
  const resolvedSkillsDir = path.resolve(skillsDir);
  await fs.mkdir(resolvedSkillsDir, { recursive: true });
  const target = path.normalize(path.join(resolvedSkillsDir, name));
  if (path.dirname(target) !== resolvedSkillsDir) throw new Error('技能安装路径不安全');
  const staging = path.join(resolvedSkillsDir, `.install-${randomUUID()}`);
  try {
    await fs.access(target);
    throw new Error('这个技能已经装过了');
  } catch (err) {
    if (err instanceof Error && err.message === '这个技能已经装过了') throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await fs.cp(sourceDir, staging, { recursive: true, dereference: true, errorOnExist: true, force: false });
    await fs.rename(staging, target);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }
}

export async function installLocalSkill(options: InstallOptions): Promise<LocalSkillInstallResult> {
  try {
    const inspection = await inspectLocalSkill(options.sourceDir);
    const manifestPath = path.join(inspection.sourceDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    let draft = manifest;
    if (options.choice.mode === 'manual') {
      if (!options.choice.displayName.trim() || !options.choice.description.trim()) return { ok: false, message: '请填写中文名和中文描述' };
      draft = { ...manifest, displayName: options.choice.displayName.trim(), description: options.choice.description.trim() };
    }
    const skill = parseSkillDefinition(draft, inspection.name);
    await copySkillDirectoryAtomically(inspection.sourceDir, skill.name, options.skillsDir ?? defaultSkillsDir());
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, ...skill }, null, 2), 'utf8');
    return { ok: true, skill };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : '技能安装失败' };
  }
}
