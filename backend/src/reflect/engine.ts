/**
 * Reflect — 反思循环引擎
 *
 * 灵枢 V2 — Spec 1 反思循环 (W3)
 *
 * 借鉴:
 *   - 白龙马 `consolidation-loop.js` (30min 间隔 + round-robin trigger)
 *   - Grok `dream.rs` (gate + 时间窗 + session 数)
 *
 * 核心约束:
 *   - 不阻塞主循环: maybeReflect 返回 Promise 但调用方不需要 await
 *   - 5min cooldown: 同一 trigger 至少间隔
 *   - 5s force-await 超时: LLM 卡住也不挂
 *   - 错误静默: LLM 抛错 → 返回 null, console.warn 记录
 *   - 写入 memory/thought (kind: 'reflection'), 不影响主路径
 */

import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../agent/verifier.js';
import type { UACSEnvelope } from '../uacs/envelope.js';
import { buildReflectPrompt } from './prompt.js';
import type {
  Reflection,
  ReflectCtx,
  ReflectTrigger,
  ReflectVerdict,
  ReflectLLMResponse,
} from './types.js';

/** trigger 字符串 key (用于 cooldown Map 的去重) */
function triggerKey(trigger: ReflectTrigger): string {
  switch (trigger.kind) {
    case 'goal_complete':
      return `goal_complete:${trigger.goalId}`;
    case 'plan_completed':
      return `plan_completed:${trigger.planId}`;
    case 'idle':
      return `idle:${trigger.idleMinutes}`;
    case 'error_threshold':
      return `error_threshold:${trigger.windowSec}:${trigger.count}`;
  }
}

/** 默认超时 5s — force-await 兜底 */
export const DEFAULT_REFLECT_TIMEOUT_MS = 5_000;
/** 默认 cooldown 5min — 同一 trigger 至少间隔 */
export const DEFAULT_REFLECT_COOLDOWN_MS = 5 * 60 * 1000;

/** 反思引擎依赖 */
export interface ReflectionEngineDeps {
  /** LLM 提供方 (单次 JSON 问答) */
  llm: LLMProvider;
  /** 立即广播一个 envelope (走 awareness 通道) */
  emit: (env: UACSEnvelope) => void;
  /** 写入 memory/thought (kind: 'reflection'), 返回 thought id */
  writeThought: (text: string, kind: 'reflection') => Promise<string>;
  /** 同 trigger 至少间隔 (ms), 默认 5min */
  cooldownMs?: number;
  /** force-await 上限 (ms), 默认 5s */
  timeoutMs?: number;
  /** Clock override (测试用) */
  now?: () => number;
}

export interface ReflectionEngine {
  /** 检查 cooldown 后调 LLM, 失败静默 */
  maybeReflect(trigger: ReflectTrigger, ctx: ReflectCtx): Promise<Reflection | null>;
  /** 立即反思, 不检查 cooldown */
  forceReflect(trigger: ReflectTrigger, ctx: ReflectCtx): Promise<Reflection>;
  /** 列出最近 N 条反思 */
  listRecent(limit: number): Reflection[];
  /** 测试/调试用: 清空 cooldown */
  resetCooldowns(): void;
}

/** 把可能为字符串的 verdict 收敛到合法枚举 */
function normalizeVerdict(v: unknown): ReflectVerdict {
  if (v === 'efficient' || v === 'wasteful' || v === 'wrong' || v === 'unclear') {
    return v;
  }
  return 'unclear';
}

/** 安全解析 LLM 返回的 JSON */
function parseLLMResponse(text: string): ReflectLLMResponse | null {
  try {
    const obj = JSON.parse(text) as Partial<ReflectLLMResponse>;
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.hypothesis !== 'string') return null;
    if (typeof obj.action !== 'string') return null;
    if (!Array.isArray(obj.evidence)) return null;
    return {
      hypothesis: obj.hypothesis,
      action: obj.action,
      evidence: obj.evidence.filter((s): s is string => typeof s === 'string'),
      verdict: normalizeVerdict(obj.verdict),
      correction: typeof obj.correction === 'string' ? obj.correction : undefined,
    };
  } catch {
    return null;
  }
}

/** force-await 包装: Promise.race(LLM, timeout) */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(onTimeout());
    }, ms);
    // Don't keep Node alive for the timer alone
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // eslint-disable-next-line no-console
        console.warn('[reflect] LLM call failed:', err instanceof Error ? err.message : String(err));
        resolve(onTimeout());
      },
    );
  });
}

export function createReflectionEngine(deps: ReflectionEngineDeps): ReflectionEngine {
  const cooldownMs = deps.cooldownMs ?? DEFAULT_REFLECT_COOLDOWN_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_REFLECT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  /** trigger key → 上次触发 unix-ms */
  const cooldowns = new Map<string, number>();
  /** 反思历史 (用于 listRecent) */
  const history: Reflection[] = [];

  /** 把 Reflection 写成可读 thought 文本 */
  function thoughtText(r: Omit<Reflection, 'id' | 'createdAt' | 'thoughtId'>): string {
    const lines = [
      `[反思] verdict=${r.verdict}`,
      `hypothesis: ${r.hypothesis}`,
      `action: ${r.action}`,
      `evidence: ${r.evidence.join('; ') || '(无)'}`,
    ];
    if (r.correction) lines.push(`correction: ${r.correction}`);
    return lines.join('\n');
  }

  /** 把一个 trigger 字符串展开 (供 awareness 广播) */
  function describeTriggerKey(trigger: ReflectTrigger): string {
    switch (trigger.kind) {
      case 'goal_complete': return `goal_complete:${trigger.goalId}`;
      case 'plan_completed': return `plan_completed:${trigger.planId}`;
      case 'idle': return `idle:${trigger.idleMinutes}`;
      case 'error_threshold': return `error_threshold:${trigger.windowSec}s/${trigger.count}`;
    }
  }

  async function performReflect(
    trigger: ReflectTrigger,
    ctx: ReflectCtx,
  ): Promise<Reflection | null> {
    const startedAt = now();
    // 立即广播 started (调用方 await 不阻塞, 这里 fire-and-forget)
    const startedEnv = {
      id: randomUUID(),
      type: 'awareness.update' as const,
      sender: 'soul' as const,
      recipient: 'electron' as const,
      timestamp: startedAt,
      correlationId: null,
      traceMeta: {},
      payload: { kind: 'reflection.started', trigger: describeTriggerKey(trigger) },
    };
    deps.emit(startedEnv as unknown as UACSEnvelope);

    const prompt = buildReflectPrompt(trigger, ctx);

    const llmResp = await withTimeout(
      deps.llm.complete({ prompt, json: true }),
      timeoutMs,
      () => ({ text: '' } as { text: string }),
    );
    const text = llmResp.text;

    if (!text) {
      // 超时或 LLM 抛错都被 withTimeout 转成空串 → null
      const errEnv = {
        id: randomUUID(),
        type: 'awareness.update' as const,
        sender: 'soul' as const,
        recipient: 'electron' as const,
        timestamp: now(),
        correlationId: null,
        traceMeta: {},
        payload: { kind: 'reflection.completed', verdict: 'unclear', note: 'timeout-or-error' },
      };
      deps.emit(errEnv as unknown as UACSEnvelope);
      return null;
    }

    const parsed = parseLLMResponse(text);
    if (!parsed) {
      const errEnv = {
        id: randomUUID(),
        type: 'awareness.update' as const,
        sender: 'soul' as const,
        recipient: 'electron' as const,
        timestamp: now(),
        correlationId: null,
        traceMeta: {},
        payload: { kind: 'reflection.completed', verdict: 'unclear', note: 'parse-failed' },
      };
      deps.emit(errEnv as unknown as UACSEnvelope);
      return null;
    }

    const reflection: Reflection = {
      id: randomUUID(),
      trigger,
      hypothesis: parsed.hypothesis,
      action: parsed.action,
      evidence: parsed.evidence,
      verdict: parsed.verdict,
      correction: parsed.correction,
      createdAt: now(),
    };

    // 写入 memory/thought (kind: 'reflection'), 失败不影响结果
    try {
      const thoughtId = await deps.writeThought(thoughtText(reflection), 'reflection');
      reflection.thoughtId = thoughtId;
    } catch (err) {
      // 写入失败不阻塞反思本身
      // eslint-disable-next-line no-console
      console.warn('[reflect] writeThought failed:', err instanceof Error ? err.message : String(err));
    }

    history.push(reflection);
    // 限上限, 防 memory leak
    if (history.length > 1000) history.shift();

    const doneEnv = {
      id: randomUUID(),
      type: 'awareness.update' as const,
      sender: 'soul' as const,
      recipient: 'electron' as const,
      timestamp: now(),
      correlationId: null,
      traceMeta: {},
      payload: { kind: 'reflection.completed', verdict: reflection.verdict },
    };
    deps.emit(doneEnv as unknown as UACSEnvelope);

    return reflection;
  }

  return {
    async maybeReflect(trigger, ctx) {
      const key = triggerKey(trigger);
      const last = cooldowns.get(key);
      if (last !== undefined && now() - last < cooldownMs) {
        return null; // 还在冷却
      }
      cooldowns.set(key, now());
      try {
        return await performReflect(trigger, ctx);
      } catch (err) {
        // LLM 抛错 → 静默, 不挂
        // eslint-disable-next-line no-console
        console.warn('[reflect] maybeReflect error:', err instanceof Error ? err.message : String(err));
        return null;
      }
    },

    async forceReflect(trigger, ctx) {
      const result = await performReflect(trigger, ctx);
      if (!result) {
        // forceReflect 不允许返回 null — 返回一个 unclear 占位
        return {
          id: randomUUID(),
          trigger,
          hypothesis: '',
          action: '',
          evidence: [],
          verdict: 'unclear',
          createdAt: now(),
        };
      }
      // 不更新 cooldown (强制反思不在冷却影响范围内)
      return result;
    },

    listRecent(limit) {
      const slice = history.slice(-limit);
      return slice;
    },

    resetCooldowns() {
      cooldowns.clear();
    },
  };
}