/**
 * Skill Creation Intent Detection (Phase W2.1)
 *
 * 识别用户说"帮我做个 X 技能" / "新建一个 X 技能" 这类意图。
 * 借鉴 Open Interpreter ask-then-build 模式,先识别再触发状态机。
 *
 * 不依赖 LLM — 纯规则匹配(快速、零延迟)。
 */

const INTENT_PATTERNS = [
  /帮我做[个一]?(.+?)的?技能/,
  /帮我创建[个一]?(.+?)的?技能/,
  /做个(.+?)的?技能/,
  /新建[一个]?(.+?)的?技能/,
  /我想做[个一]?(.+?)的?技能/,
];

export interface IntentResult {
  intent: 'create_skill' | null;
  subject?: string;
}

export function detectSkillCreationIntent(message: string): IntentResult {
  const trimmed = message.trim();
  if (!trimmed) return { intent: null };

  for (const pattern of INTENT_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m && m[1]) {
      const subject = m[1].trim().replace(/[的了呢吗呀啊]+$/, '');
      if (subject) return { intent: 'create_skill', subject };
    }
  }

  // 兜底:包含"做个技能"或"新建技能"也算
  if (/做个技能|新建技能|创建技能/.test(trimmed)) {
    return { intent: 'create_skill', subject: '未指定' };
  }

  return { intent: null };
}
