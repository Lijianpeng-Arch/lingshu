/**
 * Embedder interface + 默认 Jaccard 实现 (无 embedding 依赖).
 *
 * Borrowed from Grok xai-grok-memory mmr.rs (Jaccard 相似度算法).
 *
 * 设计要点:
 * - `embed(text)` 返回的是稀疏的 "token set" 特征向量 — 这里用 Set<string>
 *   作为简化的特征表示, 语义上等价于独热/二值向量, 可直接走 Jaccard 集合相似度
 * - `cosine(a, b)` 在二值向量上等价于 "1 - Jaccard distance" 的一个变体;
 *   这里实现为: |intersection| / sqrt(|a| * |b|)
 * - 中文分词用 Intl.Segmenter('zh'), 降级到 unicode word segmentation
 * - lowercase 后分词 (与 mmr.rs 的行为一致)
 */

export interface Embedder {
  /** 字符串 → 特征向量. 同一 embedder 必须返回 shape 一致的向量 (但不必等长) */
  embed(text: string): Promise<string[]>;
  /** 两个向量的相似度, 范围 [0, 1] (1 = 完全相同, 0 = 完全不相关) */
  cosine(a: string[], b: string[]): number;
}

// ===== 中文分词器 (懒加载, 测试可注入 mock) =====

let cachedSegmenter: Intl.Segmenter | null = null;

function getZhSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter) return cachedSegmenter;
  // Node 18+ 支持 Intl.Segmenter, 但 zh locale 不一定可用 — try/catch 兜底
  try {
    cachedSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    return cachedSegmenter;
  } catch {
    return null;
  }
}

/**
 * 把一段文本切成 token 集合 (lowercase 后).
 *
 * 中文: Intl.Segmenter('zh') 按词粒度切.
 * 英文/混合: 走 word regex + 标点分割 (字母数字下划线视为 token, 其他为分隔符).
 * 与 mmr.rs 的 Rust 实现保持一致的 "字母数字 + 下划线" 切分策略.
 */
export function tokenize(text: string): Set<string> {
  const lowered = text.toLowerCase();
  const tokens = new Set<string>();

  // 1) 中文分词
  const seg = getZhSegmenter();
  if (seg) {
    for (const piece of seg.segment(lowered)) {
      // 只取 word 粒度, 跳过标点和空白
      if (piece.isWordLike) {
        const t = piece.segment.trim();
        if (t.length > 0) tokens.add(t);
      }
    }
    // 即使有中文, 也用英文规则补充 (混合文本)
    appendEnglishTokens(lowered, tokens);
    return tokens;
  }

  // 2) 降级到纯英文规则 (Node 缺 zh locale 时)
  appendEnglishTokens(lowered, tokens);
  return tokens;
}

function appendEnglishTokens(text: string, out: Set<string>): void {
  // 只在文本含 ASCII 字母数字时跑英文规则 — 避免把整段中文当成一个 token
  // (中文是 \p{L} 但不是 [a-zA-Z], 用 ASCII-only regex 跳过纯中文)
  if (!/[a-zA-Z0-9_]/.test(text)) return;
  const matches = text.match(/[a-zA-Z0-9_]+/g);
  if (!matches) return;
  for (const m of matches) {
    const t = m.trim();
    if (t.length > 0) out.add(t);
  }
}

/**
 * Jaccard 相似度: |A ∩ B| / |A ∪ B|, 范围 [0, 1].
 * 与 mmr.rs jaccard_similarity 完全一致.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  // 遍历较小集合以提速
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of smaller) {
    if (larger.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}

/**
 * 默认 Jaccard embedder — embed 用 token set, cosine 退化为 1 - Jaccard distance.
 *
 * 注意: 因为我们用 token set 而非连续向量, "cosine" 严格意义上不算 cosine,
 * 但值域仍是 [0, 1], 1 表示完全相同, 0 表示无交集. MMR 只看相对大小,
 * 不影响排序结果, 仅保证接口语义一致.
 */
export function jaccardEmbedder(): Embedder {
  return {
    async embed(text: string): Promise<string[]> {
      return Array.from(tokenize(text));
    },
    cosine(a: string[], b: string[]): number {
      const sa = new Set(a);
      const sb = new Set(b);
      return jaccardSimilarity(sa, sb);
    },
  };
}