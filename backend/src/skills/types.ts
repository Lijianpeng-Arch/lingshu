/**
 * 技能元数据 schema — 中英双字段
 * name 英文 ID / displayName 中文 / description 中文 / version semver / lingshuMinVersion
 */

export interface SkillDefinition {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author?: string;
  lingshuMinVersion: string;
  configSchema?: Record<string, unknown>;
}
