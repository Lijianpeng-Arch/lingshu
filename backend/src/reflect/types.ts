/**
 * Reflect — types for the reflection loop.
 *
 * 灵枢 V2 — Spec 1 反思循环 (W3)。
 *
 * 借鉴:
 *   - 白龙马 `consolidation-loop.js`: 30min 间隔 + round-robin trigger
 *   - Grok `dream.rs`: gate + 时间窗 + session 数
 *
 * 设计:
 *   - 4 类 trigger: goal_complete / plan_completed / idle / error_threshold
 *   - LLM 评估最近 N 轮 envelope → hypothesis/action/evidence/verdict/correction
 *   - 写入 memory/thought (短/长 term)
 *   - 异步不阻塞主循环 + 5min cooldown + 5s force-await
 */

import type { UACSEnvelope } from '../uacs/envelope.js';

export type ReflectTrigger =
  | { kind: 'goal_complete'; goalId: string }
  | { kind: 'plan_completed'; planId: string; durationMs: number }
  | { kind: 'idle'; idleMinutes: number }
  | { kind: 'error_threshold'; windowSec: number; count: number };

export type ReflectVerdict = 'efficient' | 'wasteful' | 'wrong' | 'unclear';

export interface Reflection {
  id: string;
  trigger: ReflectTrigger;
  /** LLM 假设的当时策略 */
  hypothesis: string;
  /** 当时采取的动作 */
  action: string;
  /** 引用的证据 (envelope id / tool 结果摘要) */
  evidence: string[];
  /** 评估结论 */
  verdict: ReflectVerdict;
  /** 当 verdict !== 'efficient' 时的修正建议 */
  correction?: string;
  /** 关联写入的 thought id (memory/thought) */
  thoughtId?: string;
  createdAt: number;
}

export interface ReflectCtx {
  /** 最近 N 轮 envelope (默认 20) */
  recentEnvelopes: UACSEnvelope[];
  /** 最近工具调用 (含耗时与成败) */
  recentTools: Array<{ name: string; ok: boolean; ms: number }>;
  /** 最近用户/系统反馈 (允许 / 拒绝 / 提示) */
  recentFeedback: Array<{ kind: 'allow' | 'deny' | 'nudge'; text?: string }>;
}

/** LLM 返回的反思 JSON 形状 */
export interface ReflectLLMResponse {
  hypothesis: string;
  action: string;
  evidence: string[];
  verdict: ReflectVerdict;
  correction?: string;
}