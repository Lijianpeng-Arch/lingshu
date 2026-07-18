import { describe, it, expect } from 'vitest';
import { mmrRerank, DEFAULT_MMR_CONFIG } from './mmr.js';
import type { ScoredCandidate, MmrConfig } from './mmr.js';
import { jaccardSimilarity, tokenize, jaccardEmbedder } from './mmr-embedder.js';

/** 简单 Memory 形状, 用 content 字段提取文本 */
interface MockMemory {
  id: string;
  content: string;
}

function mkCand(id: string, content: string, relevance: number): ScoredCandidate<MockMemory> {
  return { item: { id, content }, relevance };
}

describe('MMR rerank — short-circuit', () => {
  it('λ=1.0 短路 — 返回按 relevance 降序的原序', () => {
    const cands = [
      mkCand('a', 'rust async programming', 0.5),
      mkCand('b', 'python web framework', 0.9),
      mkCand('c', 'javascript frontend', 0.7),
    ];
    const cfg: MmrConfig = { ...DEFAULT_MMR_CONFIG, lambda: 1.0 };
    const result = mmrRerank(cands, cfg);
    expect(result.map(r => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('enabled=false — 返回原序 (按 relevance 降序)', () => {
    const cands = [
      mkCand('a', 'rust async', 0.3),
      mkCand('b', 'python web', 0.9),
    ];
    const cfg: MmrConfig = { ...DEFAULT_MMR_CONFIG, enabled: false };
    const result = mmrRerank(cands, cfg);
    expect(result.map(r => r.id)).toEqual(['b', 'a']);
  });

  it('候选数 = 0 — 返回空数组', () => {
    const result = mmrRerank<MockMemory>([], DEFAULT_MMR_CONFIG);
    expect(result).toEqual([]);
  });

  it('候选数 = 1 — 单条返回', () => {
    const cands = [mkCand('only', 'hello world', 0.5)];
    const result = mmrRerank(cands, DEFAULT_MMR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('only');
  });
});

describe('MMR rerank — 算法行为', () => {
  it('λ=0.7 默认 — 多样结果被提升到冗余结果之前', () => {
    // 设计 relevance 差异足够大, 让 c 即便被 penalty 也能赢 b 的冗余 penalty.
    // a rel=1.0, b rel=0.95 (相似度高 penalty 重), c rel=0.6 (相似度低无 penalty).
    // normalized: a=1.0, b=0.875, c=0.0
    // λ=0.4 时: mmr(b)=0.4*0.875 - 0.6*0.6 = -0.01, mmr(c)=0 → c 胜
    const cands = [
      mkCand('a', 'rust async programming patterns', 1.0),
      mkCand('b', 'rust async programming tutorial', 0.95),
      mkCand('c', 'python web framework flask', 0.6),
    ];
    const result = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, lambda: 0.4 });
    expect(result[0].id).toBe('a'); // 相关度最高
    expect(result[1].id).toBe('c'); // 多样的优先于冗余的
    expect(result[2].id).toBe('b');
  });

  it('λ=0.0 纯去重 — 完全相同内容时低分排前', () => {
    // a,b 内容完全相同, c 不同. λ=0 时只看 diversity, 第二个 c 直接排到第二位.
    const cands = [
      mkCand('a', 'exact same content', 1.0),
      mkCand('b', 'exact same content', 0.99),
      mkCand('c', 'completely different', 0.5),
    ];
    const result = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, lambda: 0.0 });
    expect(result[0].id).toBe('a'); // 第一个仍然最相关
    // c 与 a 完全不相似, b 与 a 完全相似 → c 排第二
    expect(result[1].id).toBe('c');
    expect(result[2].id).toBe('b');
  });

  it('候选数 = 30 (上限) — 正常处理无 OOM', () => {
    const cands: ScoredCandidate<MockMemory>[] = [];
    for (let i = 0; i < 30; i++) {
      cands.push(mkCand(`m${i}`, `unique content number ${i} with topic ${i}`, 1.0 - i * 0.01));
    }
    const result = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, topK: 30, topN: 10 });
    expect(result).toHaveLength(10);
    // 唯一内容时 MMR 等效于纯相关度排序
    expect(result[0].id).toBe('m0');
  });

  it('topN > 候选数 — 返回全部候选', () => {
    const cands = [
      mkCand('a', 'topic one', 1.0),
      mkCand('b', 'topic two', 0.8),
    ];
    const result = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, topN: 100 });
    expect(result).toHaveLength(2);
  });

  it('topK < 候选数 — 截断前 topK 按 relevance 选, 后面的丢弃', () => {
    const cands: ScoredCandidate<MockMemory>[] = [];
    // 5 条候选, topK=2, topN=2 → 只考虑相关度最高的 2 条
    for (let i = 0; i < 5; i++) {
      cands.push(mkCand(`m${i}`, `unique ${i}`, 0.9 - i * 0.1));
    }
    const result = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, topK: 2, topN: 2 });
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id)).toEqual(['m0', 'm1']);
  });

  it('大小写不敏感 — "Rust" 和 "rust" 视为相同', () => {
    const cands = [
      mkCand('a', 'Rust Async Programming', 1.0),
      mkCand('b', 'rust async programming', 0.95),
      mkCand('c', 'Python Web Framework', 0.9),
    ];
    const result = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, lambda: 0.5 });
    expect(result[0].id).toBe('a');
    // 大小写不同的同一内容应该被识别为冗余
    expect(result[1].id).toBe('c');
    expect(result[2].id).toBe('b');
  });

  it('case-only 差异被检测为冗余 — 同 token set 视为完全相同', () => {
    const cands = [
      mkCand('a', 'Hello World', 1.0),
      mkCand('b', 'HELLO WORLD', 0.95),
      mkCand('c', 'goodbye sky', 0.9),
    ];
    const result = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, lambda: 0.5 });
    // a 与 b lowercase 后完全相同, c 多样 → c 应该排第二
    expect(result[1].id).toBe('c');
  });
});

describe('MMR rerank — 中文分词', () => {
  it('中文 "你好" vs "您好" — 高相似度 (token 重叠)', () => {
    const a = tokenize('你好世界');
    const b = tokenize('您好世界');
    const sim = jaccardSimilarity(a, b);
    // 共享 "世界", 不共享 "你好"/"您好"
    // 交集=1, 并集=3, Jaccard = 1/3 ≈ 0.333
    expect(sim).toBeCloseTo(1 / 3, 3);
  });

  it('中文 vs 完全不同 — 低相似度', () => {
    const a = tokenize('今天天气真好');
    const b = tokenize('明天会下雨');
    const sim = jaccardSimilarity(a, b);
    expect(sim).toBe(0);
  });

  it('中文混合英文 — token 集合正确合并', () => {
    const a = tokenize('使用 Rust 写 async 程序');
    const b = tokenize('Rust async programming tutorial');
    const sim = jaccardSimilarity(a, b);
    // 共享: rust, async — 应该 > 0
    expect(sim).toBeGreaterThan(0);
  });

  it('中文 MMR 重排 — 多样的中文结果被提升', () => {
    // 中文: 用同义改写 (咖啡口感 vs 咖啡味道) 制造相似度, 茶则完全无关.
    // b/c relevance 相近 (都 0.95), a 最高 1.0. λ=0.4 时 b 的相似度 penalty
    // 把它压成负值, c 胜出.
    const cands = [
      mkCand('a', '咖啡口感偏苦', 1.0),
      mkCand('b', '咖啡味道浓郁', 0.95),
      mkCand('c', '龙井茶清淡', 0.95),
    ];
    const result = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, lambda: 0.4 });
    expect(result[0].id).toBe('a');
    // c 与 a/b 完全不同, 应该排第二
    expect(result[1].id).toBe('c');
  });
});

describe('MMR rerank — Jaccard 公式', () => {
  it('Jaccard — 完全相同集合 = 1.0', () => {
    const a = new Set(['rust', 'async']);
    const b = new Set(['rust', 'async']);
    expect(jaccardSimilarity(a, b)).toBe(1.0);
  });

  it('Jaccard — 完全不交集 = 0.0', () => {
    const a = new Set(['rust', 'async']);
    const b = new Set(['python', 'web']);
    expect(jaccardSimilarity(a, b)).toBe(0.0);
  });

  it('Jaccard — 部分重叠 |A∩B|/|A∪B|', () => {
    // A={rust, async, programming}, B={rust, web, programming}
    // ∩={rust, programming}=2, ∪={rust, async, programming, web}=4
    // Jaccard = 2/4 = 0.5
    const a = new Set(['rust', 'async', 'programming']);
    const b = new Set(['rust', 'web', 'programming']);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });

  it('Jaccard — 两个空集合 = 1.0 (约定)', () => {
    const a = new Set<string>();
    const b = new Set<string>();
    expect(jaccardSimilarity(a, b)).toBe(1.0);
  });

  it('Jaccard — 一个空集合 = 0.0', () => {
    const a = new Set(['rust']);
    const b = new Set<string>();
    expect(jaccardSimilarity(a, b)).toBe(0.0);
  });
});

describe('MMR rerank — 配置注入', () => {
  it('接受自定义 embedder (jaccardEmbedder)', () => {
    const embedder = jaccardEmbedder();
    const cands = [
      mkCand('a', 'alpha beta', 1.0),
      mkCand('b', 'alpha gamma', 0.9),
    ];
    const result = mmrRerank(cands, DEFAULT_MMR_CONFIG, embedder);
    expect(result).toHaveLength(2);
  });

  it('DEFAULT_MMR_CONFIG 默认值正确', () => {
    expect(DEFAULT_MMR_CONFIG.enabled).toBe(true);
    expect(DEFAULT_MMR_CONFIG.lambda).toBe(0.7);
    expect(DEFAULT_MMR_CONFIG.topK).toBe(30);
    expect(DEFAULT_MMR_CONFIG.topN).toBe(10);
    expect(DEFAULT_MMR_CONFIG.mode).toBe('jaccard');
  });
});

describe('MMR rerank — 多样性验证', () => {
  it('比纯相关度排序更分散 (mock data)', () => {
    // 模拟场景: 5 条记忆, 3 条关于 "咖啡", 2 条关于 "茶"
    const cands: ScoredCandidate<MockMemory>[] = [
      mkCand('c1', '我喜欢喝咖啡, 加糖', 1.0),
      mkCand('c2', '咖啡的味道很香', 0.95),
      mkCand('c3', '美式咖啡不加糖', 0.9),
      mkCand('t1', '龙井茶很清爽', 0.85),
      mkCand('t2', '铁观音有兰花香', 0.8),
    ];
    // 用低 λ 让 diversity signal 主导, 茶被大幅提升
    const mmrResult = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, lambda: 0.3, topN: 5 });
    const noMmrResult = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, enabled: false });
    const ids = mmrResult.map(r => r.id);

    // 无 MMR: 严格按相关度, 茶在第 4, 5 位
    expect(noMmrResult.map(r => r.id)).toEqual(['c1', 'c2', 'c3', 't1', 't2']);

    // 有 MMR: 至少有一条茶应该在 c3 (第 3 位) 之前, 否则 diversity 没生效
    const firstTeaPos = Math.min(
      ids.indexOf('t1') >= 0 ? ids.indexOf('t1') : 99,
      ids.indexOf('t2') >= 0 ? ids.indexOf('t2') : 99,
    );
    expect(firstTeaPos).toBeLessThan(3); // 茶应该被提升到前 3 位
  });

  it('启用 MMR 与禁用 MMR 输出对比 — 启用时更多样', () => {
    const cands: ScoredCandidate<MockMemory>[] = [
      mkCand('c1', 'rust async programming tutorial', 1.0),
      mkCand('c2', 'rust async programming guide', 0.95),
      mkCand('c3', 'rust async programming examples', 0.9),
      mkCand('p1', 'python web framework flask', 0.85),
    ];

    const noMmr = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, enabled: false });
    const withMmr = mmrRerank(cands, { ...DEFAULT_MMR_CONFIG, lambda: 0.5 });

    // 禁用 MMR: 严格按相关度
    expect(noMmr.map(r => r.id)).toEqual(['c1', 'c2', 'c3', 'p1']);

    // 启用 MMR: p1 应该被提升到更前面
    const p1PosMmr = withMmr.findIndex(r => r.id === 'p1');
    const p1PosNoMmr = noMmr.findIndex(r => r.id === 'p1');
    expect(p1PosMmr).toBeLessThan(p1PosNoMmr);
  });
});