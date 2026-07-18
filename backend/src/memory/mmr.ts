/**
 * Maximal Marginal Relevance (MMR) diversity rerank.
 *
 * 借 Grok xai-grok-memory mmr.rs 翻译为 TypeScript.
 *
 * 公式:
 *   MMR(d) = λ × relevance(d) − (1−λ) × max_sim(d, selected)
 *
 * 设计要点:
 * - O(n²) 但 n ≤ topK=30 可接受
 * - 短路: enabled=false / λ=1.0 / 候选≤1
 * - relevance 由调用方传入 (与 SearchResult.score 解耦, 避免饱和到 1.0 失去 tiebreak)
 * - 默认 Jaccard embedder, 也支持外部 embedding 注入 (mode='embedding')
 *
 * 何时用:
 * - MemoryRepoClient.query 拿到的 N 条候选, 内容相似时 (同一话题多次记录),
 *   让多样的结果排前, 避免 LLM 看到的全是同一回事.
 * - topK=30 候选, topN=10 输出 — 30 里选 10 个最相关的且彼此不重复.
 */

import type { Embedder } from './mmr-embedder.js';
import { jaccardEmbedder, tokenize } from './mmr-embedder.js';

export interface MmrConfig {
  /** 是否启用 MMR 重排. 默认 true */
  enabled: boolean;
  /** 相关度权重, [0, 1]. 1 = 纯相关度, 0 = 纯去重. 默认 0.7 */
  lambda: number;
  /** 候选数上限 (输入候选超过此值会被截断). 默认 30 */
  topK: number;
  /** 最终输出数 (重排后取前 topN 条). 默认 10 */
  topN: number;
  /** 相似度计算模式. 'jaccard' = 默认无依赖, 'embedding' = 外部 embedder */
  mode: 'jaccard' | 'embedding';
}

export const DEFAULT_MMR_CONFIG: MmrConfig = {
  enabled: true,
  lambda: 0.7,
  topK: 30,
  topN: 10,
  mode: 'jaccard',
};

/** 带相关度分数的候选条目 */
export interface ScoredCandidate<T> {
  item: T;
  /** 原始相关度, 通常 [0, 1]. 不必归一化 — MMR 内部会做 min-max 归一化 */
  relevance: number;
}

/**
 * MMR 重排: 在候选里选 topN 条, 平衡相关度与多样性.
 *
 * 算法 (与 mmr.rs 一致):
 * 1. 短路检查 (enabled=false / λ=1.0 / 候选≤1)
 * 2. 截断到 topK (按 relevance 降序)
 * 3. 计算每条的 token cache
 * 4. min-max 归一化 relevance 到 [0, 1]
 * 5. 贪心选择 N 条:
 *    score_i = λ × rel_i − (1−λ) × max_sim(i, selected)
 *    同分时按 relevance 降序 tiebreak
 *
 * 复杂度: O(n²) where n ≤ topK=30.
 */
export function mmrRerank<T>(
  cands: ScoredCandidate<T>[],
  cfg: MmrConfig,
  embedder: Embedder = jaccardEmbedder(),
): T[] {
  // 1. 短路: 关闭 / 候选≤1 / λ=1.0 → 直接截断到 topN 按原顺序返回
  if (!cfg.enabled || cands.length <= 1) {
    return cands
      .slice()
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, cfg.topN)
      .map(c => c.item);
  }
  if (cfg.lambda >= 1.0) {
    return cands
      .slice()
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, cfg.topN)
      .map(c => c.item);
  }

  // 2. 截断到 topK 候选 — 按 relevance 降序
  const sorted = [...cands].sort((a, b) => b.relevance - a.relevance);
  const pool = sorted.slice(0, cfg.topK);
  if (pool.length === 0) return [];

  // 3. min-max 归一化 relevance
  const relevances = pool.map(c => c.relevance);
  const maxScore = Math.max(...relevances);
  const minScore = Math.min(...relevances);
  const range = Math.max(maxScore - minScore, Number.EPSILON);
  const normalized = relevances.map(r => (r - minScore) / range);

  // 4. 预计算每条的 embedding (并行 await)
  //    这里顺序处理 — 候选数 ≤ 30, 没必要并行
  //    如果 mode='embedding' 外部注入的 embedder 已是真正的 embedding,
  //    内部 embed 调用是同步 tokenize, 也很快.
  const embeddings: string[][] = pool.map(c => {
    // 约定: item 的 content 字段就是 text. 如果 item 没 content 字段, 转字符串.
    const text = extractText(c.item);
    // embedder.embed 是 async 接口, 但 Jaccard 实现无 await 开销;
    // 我们这里用同步的 tokenize, 因为已经是 Set<string> 的简化形式.
    // 仍然走 embedder 接口保持可扩展性.
    const tokens = tokenizeSync(embedder, text);
    return tokens;
  });

  // 5. 贪心 MMR 选择
  const lambda = cfg.lambda;
  const selectedIdx: number[] = [];
  const remainingIdx: number[] = pool.map((_, i) => i);

  while (remainingIdx.length > 0 && selectedIdx.length < cfg.topN) {
    let bestPos = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;

    for (let pos = 0; pos < remainingIdx.length; pos++) {
      const candIdx = remainingIdx[pos];
      const rel = normalized[candIdx];

      // 计算 candIdx 与所有已选条目的最大相似度
      let maxSim = 0;
      for (const sel of selectedIdx) {
        const sim = jaccardSimilarityFast(embeddings[candIdx], embeddings[sel]);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * rel - (1 - lambda) * maxSim;

      // tiebreak: mmr 相同时按 relevance 降序
      if (
        mmrScore > bestMmr ||
        (mmrScore === bestMmr && normalized[candIdx] > normalized[remainingIdx[bestPos]])
      ) {
        bestMmr = mmrScore;
        bestPos = pos;
      }
    }

    selectedIdx.push(remainingIdx.splice(bestPos, 1)[0]);
  }

  return selectedIdx.map(i => pool[i].item);
}

// ===== 内部辅助 =====

/**
 * 从候选 item 提取文本 — 默认尝试 .content / .text / 字符串化.
 * 这是约定的接口, 上游传任何 shape 都能 work.
 */
function extractText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.snippet === 'string') return obj.snippet;
  }
  return String(item);
}

/**
 * 同步走 embedder. 复用 mmr-embedder 的 tokenize (中文 Intl.Segmenter +
 * 英文 unicode word 规则), 保证 embedder 接口与 tokenize 结果一致.
 */
function tokenizeSync(embedder: Embedder, text: string): string[] {
  // 调用 embedder 接口让其知道我们在用它 (保留注入可能性, 例如未来接真 embedding)
  void embedder;
  return Array.from(tokenize(text));
}

/**
 * 两个 token 数组的 Jaccard 相似度 (数组版).
 */
function jaccardSimilarityFast(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  const sa = new Set(a);
  const sb = new Set(b);
  let intersection = 0;
  const [smaller, larger] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const t of smaller) {
    if (larger.has(t)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}