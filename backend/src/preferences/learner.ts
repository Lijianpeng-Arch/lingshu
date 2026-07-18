/**
 * preferences/learner — extract preferences from conversation via LLM
 *
 * Spec 2D — persistent main loop (Phase E)
 *
 * Borrowed from:
 *   - ChatGPT Memory: extract user facts from conversation history, persist as memory
 *   - LangChain AutoGPT preference extraction: ask LLM to produce JSON of {key, value}
 *   - 白龙马 `preference_extractor.py`: regex + LLM hybrid (we use LLM-only)
 *
 * 设计:
 *   - learnFromMessage(userMsg, assistantReply): 调 LLM 提取偏好, merge 到 store
 *   - extractPreferences(text): 暴露纯函数, 给 main-loop 等也可以直接调
 *   - applyExplicit(key, value): 用户明确说"记住..."时使用 (source='explicit')
 *
 * Prompt 模板:
 *   "从以下对话中, 提取用户的偏好 (key/value JSON array).
 *    没明显偏好就返回 []. 只返回 JSON, 不要其他文字."
 *
 * Error handling:
 *   - LLM 返回非法 JSON → 返回 [], 不抛错 (静默降级)
 *   - LLM 返回数组但不合法 (对象缺 key/value) → 跳过该条, 不抛错
 */

import type { LLMProvider } from '../agent/verifier.js';
import type { PreferenceStore } from './store.js';

export interface ExtractedPreference {
  key: string;
  value: unknown;
  /** LLM 可选给置信度; 不给时使用默认 0.5 */
  confidence?: number;
}

export interface PreferenceLearnerDeps {
  store: PreferenceStore;
  llm: LLMProvider;
}

export interface PreferenceLearner {
  /** 调 LLM 提取偏好, merge 到 store. 返回成功写入的条数 */
  learnFromMessage(userMessage: string, assistantReply: string): Promise<number>;
  /** 纯函数: 调 LLM 提取偏好 (不写 store) */
  extractPreferences(text: string): Promise<ExtractedPreference[]>;
  /** 显式调用: 用户说"记住我喜欢 X" 时使用 (source='explicit') */
  applyExplicit(key: string, value: unknown): void;
}

const PROMPT_TEMPLATE = (userMsg: string, asstReply: string) =>
  `从以下对话中, 提取用户的偏好设置。
返回一个 JSON 数组, 每项形如 {"key": "...", "value": "..."}.
"key" 用英文 snake_case 短命名 (e.g. "default_mode", "favorite_mode", "language", "theme").
"value" 可以是字符串、数字、布尔或数组。
如果对话里没有明确的用户偏好, 返回 [].
只输出 JSON, 不要解释, 不要 markdown 代码块.

用户: ${userMsg}
助手: ${asstReply}

JSON:`;

const FALLBACK_PROMPT = (text: string) =>
  `从以下文本中提取用户偏好设置, 返回 JSON 数组 (没有偏好则返回 []):
${text}

JSON:`;

function safeParseArray(text: string): ExtractedPreference[] {
  // 去掉可能的 markdown 围栏
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const valid: ExtractedPreference[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.key !== 'string' || obj.key.length === 0) continue;
    if (!('value' in obj)) continue;
    valid.push({
      key: obj.key,
      value: obj.value,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : undefined,
    });
  }
  return valid;
}

export function createPreferenceLearner(deps: PreferenceLearnerDeps): PreferenceLearner {
  const { store, llm } = deps;

  return {
    async learnFromMessage(userMessage, assistantReply) {
      let extracted: ExtractedPreference[];
      try {
        const prompt = PROMPT_TEMPLATE(userMessage, assistantReply);
        const res = await llm.complete({ prompt, json: true });
        extracted = safeParseArray(res.text ?? '');
      } catch (err) {
        console.warn('[preferences/learner] LLM call failed, silently ignoring:', err instanceof Error ? err.message : String(err));
        return 0;
      }

      let written = 0;
      for (const pref of extracted) {
        try {
          store.merge(pref.key, pref.value, 'inferred');
          written += 1;
        } catch (err) {
          console.warn('[preferences/learner] merge failed for', pref.key, err);
        }
      }
      return written;
    },

    async extractPreferences(text) {
      try {
        const res = await llm.complete({ prompt: FALLBACK_PROMPT(text), json: true });
        return safeParseArray(res.text ?? '');
      } catch (err) {
        console.warn('[preferences/learner] extract failed:', err instanceof Error ? err.message : String(err));
        return [];
      }
    },

    applyExplicit(key, value) {
      store.merge(key, value, 'explicit');
    },
  };
}
