/**
 * 技能元数据自动翻译 — 缺 displayName/description 时,调 LLM 翻译
 *
 * 兜底:翻译失败抛 SkillTranslationError,调用方降级到"手填输入"模式
 *
 * Spec 1 / Task 6: 新增 LocalizedSkillDraft 泛型,允许输入第三方草稿
 * (不一定有 version / lingshuMinVersion),返回类型保留原始字段 + 必有 displayName/description。
 */

import type { SkillDefinition } from './types.js';

/** 翻译错误细分码 — local-installer.ts 据此映射不同中文提示 */
export type SkillTranslationErrorCode = 'empty' | 'malformed' | 'llm_failed' | 'network';

export class SkillTranslationError extends Error {
  constructor(
    message: string,
    public readonly code: SkillTranslationErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkillTranslationError';
  }
}

/**
 * 已填好的 displayName/description 草稿。
 * Task 6: 翻译只补这两项,不应该伪造完整的 SkillDefinition。
 */
export type LocalizedSkillDraft<T extends Record<string, unknown>> = T & {
  displayName: string;
  description: string;
};

const TRANSLATE_PROMPT = `你是一个技能元数据翻译器。给定英文 name 和 description,翻译成中文。

输出格式: <中文名>|<中文描述>

要求:
- 中文名 ≤ 8 字,简洁
- 中文描述 ≤ 50 字,说明做什么
- 只输出 <中文名>|<中文描述> 一行,不要其他文字

例:
input: name=weather-lookup, description=Get real-time weather for a city
output: 天气查询|查指定城市的实时天气`;

export async function translateSkill<
  T extends Record<string, unknown> & {
    name?: unknown;
    displayName?: unknown;
    description?: unknown;
  },
>(
  skill: T,
  provider: { chatStream: (req: { messages: any[]; model?: string }) => AsyncIterable<{ delta?: string }> },
): Promise<LocalizedSkillDraft<T>> {
  // 1. 已完整 → 直接返回(保留原对象字段,不再 as SkillDefinition)
  if (
    typeof skill.displayName === 'string' &&
    skill.displayName.trim() &&
    typeof skill.description === 'string' &&
    skill.description.trim()
  ) {
    return skill as LocalizedSkillDraft<T>;
  }

  // 2. 调 LLM 翻译
  const rawName = typeof skill.name === 'string' ? skill.name : 'skill';
  const prompt = `${TRANSLATE_PROMPT}\n\ninput: name=${rawName}, description=${typeof skill.description === 'string' ? skill.description : rawName}\noutput:`;
  let text = '';
  try {
    for await (const chunk of provider.chatStream({ messages: [{ role: 'user', content: prompt }] })) {
      if (chunk.delta) text += chunk.delta;
    }
  } catch (err) {
    throw new SkillTranslationError(`LLM translation failed for skill "${rawName}"`, 'llm_failed', err);
  }

  const trimmed = text.trim();
  if (!trimmed) throw new SkillTranslationError(`LLM returned empty translation for skill "${rawName}"`, 'empty');
  const [displayName, description] = trimmed.split('|').map(s => s.trim());
  if (!displayName || !description) throw new SkillTranslationError(`LLM returned malformed translation: "${trimmed}"`, 'malformed');

  return {
    ...skill,
    displayName,
    description,
  } as LocalizedSkillDraft<T>;
}

/**
 * 重新导出 SkillDefinition 类型,旧测试仍可 import { ... } from './translator.js'。
 */
export type { SkillDefinition };