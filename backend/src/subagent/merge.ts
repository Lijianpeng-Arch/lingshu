/**
 * Sub-agent 结果合并 — Spec 2C-2
 *
 * 借鉴:
 *   - LangGraph Send() return channel (fan-in 聚合)
 *   - CrewAI TaskOutput (多 agent 输出聚合)
 *
 * 设计:
 *   - mergeResults(results) → 1 个字符串 (塞回 PlanStep.result)
 *   - 默认策略: 把每个 result 的 output 用 "\n---\n" 连接
 *   - 失败/超时的 result 用 "[failed: ...]" 标出, 不丢
 *   - 提供 hasAllOk / countOk 辅助函数给 caller 决定整体 ok 状态
 */

import type { SubAgentResult } from './types.js';

export interface MergeOptions {
  /** 分隔符, 默认 "\n---\n" */
  separator?: string;
  /** 失败/超时的前缀, 默认 "[failed: <error>]" */
  failurePrefix?: string;
  /** 是否包含 tool_calls 摘要 */
  includeToolSummary?: boolean;
}

/**
 * 把多个 SubAgentResult 合并成单个字符串.
 * 不抛错; 失败的结果用前缀标注, 不会导致整个 merge 失败.
 */
export function mergeResults(
  results: SubAgentResult[],
  opts: MergeOptions = {},
): string {
  const sep = opts.separator ?? '\n---\n';
  const failPrefix = opts.failurePrefix ?? '[failed';
  const includeTools = opts.includeToolSummary ?? false;

  return results
    .map((r) => {
      if (r.ok && r.output !== undefined) {
        const toolSummary = includeTools && r.tool_calls.length > 0
          ? ` (tools: ${r.tool_calls.map((tc) => tc.tool).join(', ')})`
          : '';
        return `[${r.task_id}]${toolSummary}\n${r.output}`;
      }
      const errMsg = r.error ?? r.status;
      return `[${r.task_id}] ${failPrefix}: ${errMsg}]`;
    })
    .join(sep);
}

/** 全部 ok (没有 failed/timeout) */
export function allOk(results: SubAgentResult[]): boolean {
  return results.length > 0 && results.every((r) => r.ok);
}

/** 至少一个 ok */
export function anyOk(results: SubAgentResult[]): boolean {
  return results.some((r) => r.ok);
}

/** 统计 ok 的数量 */
export function countOk(results: SubAgentResult[]): number {
  return results.filter((r) => r.ok).length;
}

/** 统计 total tool_calls */
export function totalToolCalls(results: SubAgentResult[]): number {
  return results.reduce((sum, r) => sum + r.tool_calls.length, 0);
}

/** 统计 total duration (sum) */
export function totalDuration(results: SubAgentResult[]): number {
  return results.reduce((sum, r) => sum + r.duration_ms, 0);
}

/** 取最长 duration (用于并行 wall-clock 验证) */
export function maxDuration(results: SubAgentResult[]): number {
  return results.reduce((max, r) => Math.max(max, r.duration_ms), 0);
}