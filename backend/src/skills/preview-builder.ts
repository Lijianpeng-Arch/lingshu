/**
 * 实时预览数据生成器 (Phase W2.4 chat 触发)
 *
 * 基于用户的回答 + 主题, 拼装:
 *   1. WizardPreview (复用 conversational-state 的形状)
 *   2. triggerSuggestions — 3-5 个候选触发词 (基于主题 + LLM)
 *   3. testCases — 2-3 个示例问答对 (基于主题 + LLM)
 *
 * 设计: 即便 LLM 抛错也能 fallback 出"合理可用"的预览, 不阻塞用户。
 */

import type { WizardPreview } from './conversational-state.js';
import type { SkillLayer } from './skill-types.js';
import { classifySkillType } from './skill-types.js';
import type { LLMProvider } from '../agent/verifier.js';

export interface PreviewData {
  preview: WizardPreview;
  triggerSuggestions: string[];
  testCases: Array<{ input: string; expected: string }>;
}

const FALLBACK_TRIGGER_TEMPLATES = ['查', '帮我', '打开', '搜索', '获取'];

const FALLBACK_TEST_CASES: Array<{ input: string; expected: string }> = [
  { input: '帮我使用这个技能', expected: '好的，已为您启动' },
  { input: '这个技能能做什么？', expected: '查询相关信息并返回结果' },
];

/**
 * 基于主题启发式地生成 fallback 触发词. LLM 不可用时用.
 */
function fallbackTriggersForSubject(subject: string): string[] {
  const s = subject.trim().slice(0, 6) || '技能';
  return [
    s,
    `查${s}`,
    `${FALLBACK_TRIGGER_TEMPLATES[0]}${s}`,
    `帮我${s}`,
  ];
}

function extractJsonArray(text: string): unknown[] {
  const cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced && fenced[1] ? fenced[1].trim() : cleaned;
  // 容错: 抓第一个顶层 array
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  const json = arrayMatch ? arrayMatch[0] : candidate;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function generateTriggerSuggestions(
  subject: string,
  llm: LLMProvider | undefined,
): Promise<string[]> {
  const fallback = fallbackTriggersForSubject(subject);
  if (!llm) return fallback;

  try {
    const result = await llm.complete({
      prompt: `为主题"${subject.trim() || '通用技能'}"生成 3-5 个简短的触发词短语 (用户口语, 不超过 6 字).
返回 JSON 数组, 不要解释:
["...", "...", "..."]`,
      json: true,
    });
    const arr = extractJsonArray(result?.text ?? '');
    const triggers = arr.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    if (triggers.length >= 3) return triggers.slice(0, 5);
  } catch (err) {
    console.error('[preview-builder] trigger suggestions LLM failed:', err);
  }
  return fallback;
}

async function generateTestCases(
  subject: string,
  llm: LLMProvider | undefined,
): Promise<Array<{ input: string; expected: string }>> {
  if (!llm) return FALLBACK_TEST_CASES.slice();

  try {
    const result = await llm.complete({
      prompt: `为主题"${subject.trim() || '通用技能'}"生成 2-3 个用户→技能示例问答对.
JSON 数组格式, 每项 { "input": "用户问", "expected": "预期返回" }:
[{"input":"...","expected":"..."}]`,
      json: true,
    });
    const arr = extractJsonArray(result?.text ?? '');
    const cases: Array<{ input: string; expected: string }> = [];
    for (const item of arr) {
      if (item && typeof item === 'object' && 'input' in item && 'expected' in item) {
        const inp = (item as Record<string, unknown>).input;
        const exp = (item as Record<string, unknown>).expected;
        if (typeof inp === 'string' && typeof exp === 'string' && inp.trim() && exp.trim()) {
          cases.push({ input: inp.trim(), expected: exp.trim() });
        }
      }
    }
    if (cases.length >= 2) return cases.slice(0, 3);
  } catch (err) {
    console.error('[preview-builder] test cases LLM failed:', err);
  }
  return FALLBACK_TEST_CASES.slice();
}

/**
 * 根据答案 + 主题拼装 WizardPreview, 同时产出 triggerSuggestions + testCases.
 * 不抛错 — LLM 调用失败时静默 fallback.
 */
export async function buildPreview(
  answers: Record<string, string>,
  subject: string,
  layer: SkillLayer | undefined,
  llm: LLMProvider | undefined,
): Promise<PreviewData> {
  const resolvedLayer: SkillLayer = layer ?? classifySkillType(subject).layer;
  const displayName = answers['displayName']?.trim() || `${subject || '未命名'}助手`;
  const triggerAnswer = answers['trigger']?.trim();
  const description = answers['description']?.trim() || `${subject || '未命名'}相关技能`;
  const dataSource = answers['dataSource']?.trim();

  const id = `skill-${displayName.replace(/[^\w一-龥]/g, '-').toLowerCase()}`;

  const triggers = triggerAnswer
    ? [triggerAnswer, ...(await generateTriggerSuggestions(subject, llm))]
    : await generateTriggerSuggestions(subject, llm);

  const testCases = await generateTestCases(subject, llm);

  const preview: WizardPreview = {
    id,
    displayName,
    displayDescription:
      resolvedLayer === 'api' && dataSource
        ? `${description}（数据源: ${dataSource}）`
        : description,
    triggers,
    layer: resolvedLayer,
  };

  return { preview, triggerSuggestions: triggers, testCases };
}

/**
 * 同步版供测试 / 兜底 — 不调 LLM, 完全本地拼装.
 */
export function buildPreviewSync(answers: Record<string, string>, subject: string): PreviewData {
  const layer = classifySkillType(subject).layer;
  const displayName = answers['displayName']?.trim() || `${subject || '未命名'}助手`;
  const triggerAnswer = answers['trigger']?.trim();
  const description = answers['description']?.trim() || `${subject || '未命名'}相关技能`;
  const id = `skill-${displayName.replace(/[^\w一-龥]/g, '-').toLowerCase()}`;

  const triggers = triggerAnswer
    ? Array.from(new Set([triggerAnswer, ...fallbackTriggersForSubject(subject)]))
    : fallbackTriggersForSubject(subject);

  return {
    preview: {
      id,
      displayName,
      displayDescription: description,
      triggers,
      layer,
    },
    triggerSuggestions: fallbackTriggersForSubject(subject),
    testCases: FALLBACK_TEST_CASES.slice(),
  };
}
