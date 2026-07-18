/**
 * 技能定义 — 跨进程共享类型 (MVP package: shared-types)
 *
 * 字段名必须与 `backend/src/skills/types.ts` 的 Zod schema 保持一致;
 * Zod 是运行时校验的唯一来源,本文件是 TypeScript 编译期 mirror。
 *
 * 新位置: packages/shared-types/src/skill-types.ts
 * 老位置 (兼容保留): electron/src/shared/skill-types.ts
 */

export interface SkillDefinition {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author?: string;
  lingshuMinVersion: string;
  dependencies?: string[];
  prompt?: string;
  triggers?: string[];
  configSchema?: Record<string, unknown>;
}

/**
 * WizardSkill — 技能向导与导出/导入共享的技能定义类型。
 *
 * 与 SkillDefinition 同构;保留别名以避免上层(SettingsPage、export-skill 等)
 * 同时持有两个语义相同但不同名的类型。
 */
export type WizardSkill = SkillDefinition;