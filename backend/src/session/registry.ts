/**
 * Session Registry — 灵枢 V6 主屏数据源 (2026-07-18)
 *
 * 为什么需要:
 *   - awareness snapshot 不携带 token/call count (只回 tasks/thoughts/status/emotion)
 *   - 主屏右栏 Procyon / VsCard 需要按 provider+model 累计 token
 *   - 左栏 HarmonyCard / ChronoCard 需要本会话的 prompt/completion total + elapsedMs
 *
 * 设计:
 *   - 单例模块, 进程内 1 份, 不持久化 (重启清零, 主屏用户能接受)
 *   - SessionState 按会话 id (即 conversationId) 隔离; 当前活动会话只有一个 (current)
 *   - recordUsage(provider, model, promptTokens, completionTokens) 由 chat-stream.ts message_finish 调用
 *
 * 用法:
 *   import { sessionRegistry } from './session/registry.js';
 *   sessionRegistry.bindCurrent('conv-1', 'deepseek', 'deepseek-chat');
 *   sessionRegistry.recordUsage({ provider, model, promptTokens, completionTokens });
 *   const snap = sessionRegistry.snapshot(); // → V6 API 用的 JSON
 */
import { randomUUID } from 'node:crypto';

export interface ModelUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  lastCalledAt: number;
}

export interface SessionState {
  id: string;
  startedAt: number;
  endedAt?: number;
  mode: 'chat' | 'goal';
  goalId?: string;
  currentProvider?: string;
  currentModel?: string;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  perModel: Record<string, ModelUsage>;
}

export interface UsageSnapshot {
  currentSession: {
    id: string;
    startedAt: number;
    elapsedMs: number;
    messageCount: number;
    mode: SessionState['mode'];
    goalId?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    currentProvider?: string;
    currentModel?: string;
  } | null;
  perModel: ModelUsage[];
  todayTotal: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    calls: number;
  };
}

function emptySession(): SessionState {
  return {
    id: randomUUID(),
    startedAt: Date.now(),
    mode: 'chat',
    messageCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    perModel: {},
  };
}

class SessionRegistry {
  private current: SessionState | null = null;
  /** 当天累计 (跨 session 重启保留) */
  private todayStart = startOfDay(Date.now());
  private todayPrompt = 0;
  private todayCompletion = 0;
  private todayCalls = 0;

  /**
   * 绑定一个会话 (前端发消息时调用).
   * 同一个 id 复用, 新 id 自动开启新会话.
   */
  bindCurrent(
    id?: string,
    provider?: string,
    model?: string
  ): SessionState {
    const now = Date.now();
    // 跨天重置 today 累加
    if (startOfDay(now) !== this.todayStart) {
      this.todayStart = startOfDay(now);
      this.todayPrompt = 0;
      this.todayCompletion = 0;
      this.todayCalls = 0;
    }
    if (this.current && this.current.id !== id) {
      // 自动结束上一个会话
      this.current.endedAt = now;
    }
    if (!this.current || this.current.id !== id) {
      this.current = emptySession();
      if (id) this.current.id = id;
    }
    if (provider) this.current.currentProvider = provider;
    if (model) this.current.currentModel = model;
    return this.current;
  }

  /** 切换到 goal mode (前端启动 goal 时调用) */
  setMode(mode: SessionState['mode'], goalId?: string): void {
    if (!this.current) this.current = emptySession();
    this.current.mode = mode;
    if (goalId) this.current.goalId = goalId;
  }

  /** 累加一次 token 消耗 (chat-stream message_finish 调用) */
  recordUsage(opts: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }): void {
    if (!this.current) this.current = emptySession();
    const s = this.current;
    s.messageCount += 1;
    s.promptTokens += opts.promptTokens;
    s.completionTokens += opts.completionTokens;
    const key = `${opts.provider}::${opts.model}`;
    const existing = s.perModel[key];
    if (existing) {
      existing.promptTokens += opts.promptTokens;
      existing.completionTokens += opts.completionTokens;
      existing.calls += 1;
      existing.lastCalledAt = Date.now();
    } else {
      s.perModel[key] = {
        provider: opts.provider,
        model: opts.model,
        promptTokens: opts.promptTokens,
        completionTokens: opts.completionTokens,
        calls: 1,
        lastCalledAt: Date.now(),
      };
    }
    this.todayPrompt += opts.promptTokens;
    this.todayCompletion += opts.completionTokens;
    this.todayCalls += 1;
  }

  /** 给前端消费的快照 */
  snapshot(): UsageSnapshot {
    if (!this.current) {
      return {
        currentSession: null,
        perModel: [],
        todayTotal: {
          promptTokens: this.todayPrompt,
          completionTokens: this.todayCompletion,
          totalTokens: this.todayPrompt + this.todayCompletion,
          calls: this.todayCalls,
        },
      };
    }
    const s = this.current;
    return {
      currentSession: {
        id: s.id,
        startedAt: s.startedAt,
        elapsedMs: Date.now() - s.startedAt,
        messageCount: s.messageCount,
        mode: s.mode,
        goalId: s.goalId,
        promptTokens: s.promptTokens,
        completionTokens: s.completionTokens,
        totalTokens: s.promptTokens + s.completionTokens,
        currentProvider: s.currentProvider,
        currentModel: s.currentModel,
      },
      perModel: Object.values(s.perModel).sort(
        (a, b) => b.lastCalledAt - a.lastCalledAt
      ),
      todayTotal: {
        promptTokens: this.todayPrompt,
        completionTokens: this.todayCompletion,
        totalTokens: this.todayPrompt + this.todayCompletion,
        calls: this.todayCalls,
      },
    };
  }

  /** 重置 (测试 / 用户主动清零) */
  reset(): void {
    this.current = null;
    this.todayStart = startOfDay(Date.now());
    this.todayPrompt = 0;
    this.todayCompletion = 0;
    this.todayCalls = 0;
  }
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 全局单例 */
export const sessionRegistry = new SessionRegistry();