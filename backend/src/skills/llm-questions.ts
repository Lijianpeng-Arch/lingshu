/**
 * LLM 驱动的问题生成 (Phase W2.4 chat 触发)
 *
 * 用户说"帮我做个 X 技能" 时, LLM 帮我们生成 4-5 步提问.
 * 借鉴 Hermes 的 "progressive disclosure" 模式: 不是一次把所有问题丢出来,
 * 而是 LLM 根据主题生成**对该场景最有信息量**的子集。
 *
 * LLM 抛错/不可用 → fallback 静态 5 题 (中文名 / 触发词 / 是否要参数 / 是否要 API / 描述).
 */

import type { LLMProvider } from '../agent/verifier.js';

export interface WizardQuestion {
  id: string;
  prompt: string;
  type: 'text' | 'select' | 'multiselect' | 'confirm';
  options?: string[];
  suggestions?: string[];
}

const STATIC_FALLBACK_QUESTIONS: WizardQuestion[] = [
  {
    id: 'displayName',
    prompt: '这个技能中文名叫什么？',
    type: 'text',
    suggestions: ['助手', '查询器', '小工具'],
  },
  {
    id: 'trigger',
    prompt: '用户说什么词会触发？',
    type: 'text',
    suggestions: ['查', '帮我', '打开'],
  },
  {
    id: 'dataSource',
    prompt: '数据从哪儿来？(API 名)',
    type: 'text',
    suggestions: ['高德天气', 'GitHub API', '聚合数据'],
  },
  {
    id: 'description',
    prompt: '用一句话描述这个技能干啥？',
    type: 'text',
  },
];

const SYSTEM_PROMPT = `你是灵枢 V2 的对话式技能创建助手。根据用户想做的技能主题,
生成 3-5 个清晰的问题, 帮助用户完整定义这个技能.

要求:
1. 每题用简体中文,简洁,不啰嗦
2. type 字段必填,只能是 text/select/multiselect/confirm 之一
3. options 仅 select/multiselect 必填
4. suggestions 仅 text 可选,给 2-3 个候选短语
5. 输出严格 JSON, 不要 markdown 代码块包装

JSON schema:
{
  "questions": [
    {
      "id": "kebab-case-id",
      "prompt": "...",
      "type": "text" | "select" | "multiselect" | "confirm",
      "options": ["..."],   // 仅 select/multiselect
      "suggestions": ["..."] // 仅 text
    }
  ]
}`;

interface RawQuestion {
  id?: unknown;
  prompt?: unknown;
  type?: unknown;
  options?: unknown;
  suggestions?: unknown;
}

function sanitizeQuestion(raw: RawQuestion): WizardQuestion | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  const rawType = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  const type: WizardQuestion['type'] =
    rawType === 'select' || rawType === 'multiselect' || rawType === 'confirm' ? rawType : 'text';

  if (!id || !prompt) return null;

  const q: WizardQuestion = { id, prompt, type };
  if ((type === 'select' || type === 'multiselect') && Array.isArray(raw.options)) {
    q.options = raw.options.filter((o): o is string => typeof o === 'string');
  }
  if (type === 'text' && Array.isArray(raw.suggestions)) {
    q.suggestions = raw.suggestions.filter((s): s is string => typeof s === 'string');
  }
  return q;
}

function parseQuestionsFromText(text: string): WizardQuestion[] {
  // 1. 试着直接 parse; 包了 ```json ... ``` 也行.
  let cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) cleaned = fenced[1].trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed?.questions)) {
      return parsed.questions
        .map((q: RawQuestion) => sanitizeQuestion(q))
        .filter((q: WizardQuestion | null): q is WizardQuestion => q !== null);
    }
  } catch {
    // swallow, fall through
  }

  // 2. 容错: 抓第一个 {...questions: [...]} 块. (防止 LLM 在外面加说明文字)
  const m = cleaned.match(/\{[\s\S]*"questions"\s*:\s*\[[\s\S]*\]\s*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed?.questions)) {
        return parsed.questions
          .map((q: RawQuestion) => sanitizeQuestion(q))
          .filter((q: WizardQuestion | null): q is WizardQuestion => q !== null);
      }
    } catch {
      // ignore
    }
  }

  return [];
}

/**
 * 调用 LLM 生成 4-5 步问题. LLM 抛错或返回无效 JSON → fallback 静态 5 题.
 * LLM 抛错不挂 — wizard 仍然可以走通, 只是问题不够贴合主题.
 */
export async function generateQuestions(
  subject: string,
  llm: LLMProvider | undefined,
): Promise<WizardQuestion[]> {
  if (!llm) return STATIC_FALLBACK_QUESTIONS.slice();

  const userPrompt = `主题: ${subject.trim() || '未指定'}

请为主题"${subject.trim() || '通用'}"生成最适合的 3-5 个技能定义问题。
只输出 JSON, 不要解释.`;

  let text = '';
  try {
    const result = await llm.complete({ prompt: `${SYSTEM_PROMPT}\n\n${userPrompt}`, json: true });
    text = result?.text ?? '';
  } catch (err) {
    console.error('[llm-questions] LLM call failed, using static fallback:', err);
    return STATIC_FALLBACK_QUESTIONS.slice();
  }

  const questions = parseQuestionsFromText(text);
  if (questions.length >= 3 && questions.length <= 5) return questions;
  if (questions.length > 5) return questions.slice(0, 5);

  // LLM 返回了但数量不对或空 → fallback
  console.warn(
    `[llm-questions] LLM returned ${questions.length} valid questions, expected 3-5, using fallback`,
  );
  return STATIC_FALLBACK_QUESTIONS.slice();
}

export const STATIC_FALLBACK = STATIC_FALLBACK_QUESTIONS;
