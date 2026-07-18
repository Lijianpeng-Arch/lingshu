/**
 * Verifier — 目标模式 LLM 二次校验
 * 灵枢 V2 — Goal 系统
 *
 * 借鉴 OpenCode LLM-as-judge 思路：用同一 provider 自我评估验收清单，
 * 输出结构化 JSON（criterion + passed + evidence），防止 agent 谎报完成。
 *
 * 设计要点：
 *   - LLMProvider 抽象独立于 Provider（chat 流式），单独针对"一次 JSON 问答"
 *     场景，避免污染主对话流
 *   - 提示词明确要"输出 JSON"，配合 json: true 让 LLM 走 JSON mode
 *   - 解析失败抛错（让 runGoalLoop 知道这是 verifier 失败，不是验收失败）
 */

import type { AcceptanceCriterion } from './acceptance.js';

/**
 * 单次 JSON 问答 provider（区别于 chat 流式 Provider）。
 * Spec §6.3 — verifier v1: agent 自己声明 + LLM 二次校验（用同一 provider）
 */
export interface LLMProvider {
  complete(req: { prompt: string; json?: boolean }): Promise<{ text: string }>;
}

export interface VerdictResult {
  /** 验收条目原文（人类可读） */
  criterion: string;
  /** 是否通过 */
  passed: boolean;
  /** 通过 / 不通过证据 */
  evidence: string;
}

export interface Verdict {
  /** 全部条目都通过 */
  allPass: boolean;
  /** 每条独立结果（含 evidence 方便 UI 展示给用户） */
  results: VerdictResult[];
}

/**
 * 用 LLM 二次校验验收清单。
 * 抛错: 当 LLM 返回无法解析为 JSON 时（这是 verifier 自身故障，不是验收失败）。
 */
export async function checkAcceptance(
  criteria: AcceptanceCriterion[],
  contextSummary: string,
  llm: LLMProvider,
): Promise<Verdict> {
  const prompt = `你是一个验收员。基于以下 agent 执行上下文, 判断每个验收标准是否通过。

上下文:
${contextSummary}

验收标准:
${criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}

输出 JSON:
{
  "results": [
    { "criterion": "<原文>", "passed": true|false, "evidence": "<证据/原因>" }
  ]
}`;

  const resp = await llm.complete({ prompt, json: true });
  const parsed = JSON.parse(resp.text) as { results?: VerdictResult[] };
  const results = parsed.results ?? [];
  // allPass 判定:
  //   - 空验收清单 → 默认通过（无验收 = 无要求）
  //   - 非空清单 → 每条都要 passed === true
  // 防御: LLM 漏返条目视为不通过（防止漏检）
  const allPass =
    results.length > 0 &&
    results.every(r => r.passed === true) &&
    results.length === criteria.length;
  return {
    allPass: criteria.length === 0 ? true : allPass,
    results,
  };
}