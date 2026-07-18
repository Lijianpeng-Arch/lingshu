/**
 * MainLoop — orchestrates the agent's self-driven tick cycle.
 *
 * Wraps the priority-adaptive scheduler with awareness broadcasting so the
 * agent has a continuous "self" loop, not just user-message-driven reactivity.
 *
 * Phase B.1: skeleton with snapshot broadcast per tick. Phase B.2 will plug in
 * real repos (tasks, thoughts, memory) and Phase B.5 will wire chat-handler
 * pending-message state.
 *
 * Phase 6 (Task 6): wires the Permission Gate + Goal Tracker into the agent
 * loop. Exposes `gateToolCall()` for chat-handler to wrap every tool.execute,
 * and `runGoalMode()` for goal-driven dispatch. Both emit AwarenessEvent
 * values to the renderer via the existing broadcast channel.
 *
 * Spec 2C-1: adds `runPlanMode()` for long-task plan-driven dispatch. Uses
 * PlanStore (sqlite) + PlanRunner (in-memory loop) + planner (LLM-based
 * decompose). Emits plan.* AwarenessEvents (created/step_started/etc.).
 *
 * Spec 2D: persistent main loop (Phase E). Adds:
 *   - idleScheduler (5min heartbeat + per-task heartbeats)
 *   - proactiveDetector (due-reminder check + error/completion detection)
 *   - preferenceStore + preferenceLearner (LLM-based preference extraction)
 *   - applyUserMessageForLearning() — entry from chat-handler
 *   - onProactiveSignal broadcast wiring
 */

import type { Database as Db } from 'better-sqlite3';
import { createScheduler, type TickReason } from '../tick/scheduler.js';
import {
  type AwarenessSnapshotPayload,
  type AwarenessUpdatePayload,
  type UACSEnvelope,
} from '../uacs/envelope.js';
import { newId } from '../util/id.js';
import { evaluate } from '../permission/gate.js';
import { loadSettings } from '../permission/settings.js';
import type { PermissionDecision, ToolDescriptor } from '../permission/types.js';
import { parseGoal, runGoalLoop, type Goal } from './goal.js';
import type { LLMProvider } from './verifier.js';
import type { AgentContext } from './goal.js';
import { type ToolDefinition, type ToolRegistry } from '../tools/registry.js';
import type { AwarenessEvent } from './awareness.js';
import { createPlanStore, type PlanRepo } from '../plan/store.js';
import { parsePlanFromGoal } from '../plan/parser.js';
import { planFromGoal } from '../planner/index.js';
import { createPlanRunner, type RunnerContext, type PlanEvent } from '../plan/runner.js';
import type { Plan } from '../plan/types.js';
import { createPreferenceStore, type PreferenceStore } from '../preferences/store.js';
import { createPreferenceLearner, type PreferenceLearner } from '../preferences/learner.js';
import { createReminderService, type ReminderService } from '../proactive/reminder.js';
import { createProactiveDetector, type ProactiveDetector } from '../proactive/detector.js';
import { createIdleScheduler, type IdleScheduler } from '../idle/scheduler.js';
import { createReflectionEngine, type ReflectionEngine, DEFAULT_REFLECT_COOLDOWN_MS } from '../reflect/engine.js';
import type { ReflectTrigger, ReflectCtx } from '../reflect/types.js';
import type { McpRegistry } from '../mcp/registry.js';

export interface MainLoopDeps {
  db: Db;
  /** Push a snapshot/update envelope to all connected renderers */
  broadcast: (env: UACSEnvelope) => void;
  /** True when a user message is pending immediate processing */
  hasPendingUserMessage: () => boolean;
  /** True while at least one task is active */
  hasActiveTask: () => boolean;
  /** True when the LLM provider is currently rate-limiting us */
  isRateLimited: () => boolean;
  /** Number of ticks elapsed since start (used for the awakening window) */
  awakeningTicks: () => number;
  /** Unix-ms when the next reminder is due; undefined when none */
  reminderDueMs: () => number | undefined;
  /** Set once on construction so buildAwarenessSnapshot can compute uptime */
  startedAtMs: number;
  // ── Spec 2D: persistent main loop (Phase E) — all optional ──
  /** LLM provider used by the preference learner. Optional but recommended. */
  llmProvider?: LLMProvider;
  /** Idle scheduler interval (ms). Default: 5min */
  idleIntervalMs?: number;
  /** Reminder check interval (ms). Default: 30s (faster so reminders don't drift) */
  reminderIntervalMs?: number;
  /** Frequency of preference learning from conversations. Default: 60s */
  preferenceLearnIntervalMs?: number;
  /** Spec 1 W3: reflection engine 同 trigger cooldown (ms). Default: 5min */
  reflectCooldownMs?: number;
  // ── MCP 协议接入 (W5) — 全部 optional, 不传则跳过 ──
  /** 启动时拉 MCP servers，注册到 toolRegistry. 不传则不动 MCP。 */
  mcpRegistry?: McpRegistry;
  /** MCP tools 注册目标。必须配合 mcpRegistry 一同传入。 */
  toolRegistry?: ToolRegistry;
}

export interface MainLoopState {
  lastTickAt: number;
  tickCount: number;
  reason: TickReason;
}

export interface MainLoop {
  start(): void;
  stop(): void;
  triggerUserMessage(): void;
  /** Build the current awareness snapshot on demand (used by handlers/tests) */
  getSnapshot(): AwarenessSnapshotPayload;
  /** Build an awareness update payload of the given kind */
  buildUpdate(kind: 'task' | 'thought' | 'status' | 'emotion', data: unknown): AwarenessUpdatePayload;
  getState(): MainLoopState;
  /** Subscribe to awareness envelopes without replacing the existing renderer broadcast. */
  subscribeAwareness(handler: (env: UACSEnvelope) => void): () => void;
  /**
   * Gate a tool call through the Permission system (Phase 6 / Task 6).
   *
   * Returns the final decision (allow / deny). When the gate says "ask",
   * an AwarenessEvent `permission.request` is broadcast, and the call blocks
   * until the user responds via `resolvePermission()` or the timeout fires.
   *
   * `toolDef` supplies the risk metadata the gate needs. The actual tool.execute
   * is NOT called here — the caller (chat-handler) is responsible for invoking
   * the tool once this returns `{ kind: 'allow' }`.
   */
  gateToolCall(
    toolDef: ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<PermissionDecision>;
  /**
   * Resolve a pending `permission.request` envelope. Returns true when a
   * resolver was found and called, false for unknown/already-resolved ids so
   * the HTTP route can answer with 404 instead of pretending success.
   */
  resolvePermission(envelopeId: string, decision: 'allow' | 'deny'): boolean;
  /**
   * Goal mode entry (Phase 6 / Task 6).
   *
   * Returns the completed/aborted Goal when userInput matches the goal-mode
   * DSL (settings.mode === 'goal' && input includes '目标:'), otherwise
   * returns null so the caller can fall through to the normal chat path.
   *
   * Spec 2A I2: verifier resilience is embedded inside runGoalLoop itself
   * (try/catch around checkAcceptance), so main-loop no longer wraps it.
   * Single source of truth for the loop body — no more drift.
   */
  runGoalMode(
    userInput: string,
    ctx: AgentContext,
    llm: LLMProvider,
  ): Promise<Goal | null>;
  /**
   * Plan mode entry (Spec 2C-1).
   *
   * Returns the completed/aborted Plan when userInput matches the plan-mode
   * DSL (settings.mode === 'plan' && input includes '目标:'), otherwise
   * returns null so the caller can fall through to the normal chat path.
   *
   * Flow:
   *   1. parseGoal → Goal
   *   2. planFromGoal (LLM) → Plan (3-5 steps); fallback to parsePlanFromGoal on failure
   *   3. PlanStore.createPlan → persist
   *   4. broadcastEvent(plan.created)
   *   5. PlanRunner.runPlan → emit plan.step_* events
   *   6. broadcastEvent(plan.completed) | final plan
   */
  runPlanMode(
    userInput: string,
    ctx: AgentContext,
    llm: LLMProvider,
  ): Promise<Plan | null>;
  /**
   * Resume a previously persisted plan (断点续跑).
   *
   * Loads plan from store by id, reverts running→pending, then runs.
   * Returns null if plan not found or already completed (no re-run).
   */
  resumePlan(
    planId: string,
    ctx: AgentContext,
    llm: LLMProvider,
  ): Promise<Plan | null>;
  /** Expose the plan store for callers that want to query plans */
  getPlanRepo(): PlanRepo;
  // ── Spec 2D: persistent main loop (Phase E) accessors ──
  /** Reminder service: add/list/fire reminders. */
  getReminderService(): ReminderService;
  /** Preference store: persistent user preferences (key/value). */
  getPreferenceStore(): PreferenceStore;
  /** Proactive detector: re-checks due reminders on demand + reports errors/completions. */
  getProactiveDetector(): ProactiveDetector;
  /** Idle scheduler: register tasks for periodic background execution. */
  getIdleScheduler(): IdleScheduler;
  /**
   * Spec 2D: extract preferences from a user message via the LLM and merge into store.
   * Called from chat-handler after each turn completes. Returns the number of prefs merged.
   * Returns 0 silently if no LLM is wired.
   */
  applyUserMessageForLearning(userMessage: string, assistantReply: string): Promise<number>;
  /** Spec 2D: explicitly set a preference (user said "记住我喜欢 X"). */
  applyExplicitPreference(key: string, value: unknown): void;
  // ── Spec 1 W3: Reflection engine accessors ──
  /** 反思循环引擎 — 测试 / 调试用 */
  getReflectionEngine(): ReflectionEngine;
  /**
   * 记录一次错误事件 (供 5min 错误超阈反思触发器用).
   * 调用方在 error envelope 出现时调用, main-loop 内部累计 + 比较阈值.
   */
  recordErrorEvent(): void;
  /**
   * 记录一次工具调用结果 (供反思 ReflectCtx 用).
   * name: 工具名; ok: 成功 / 失败; ms: 耗时.
   */
  recordToolResult(name: string, ok: boolean, ms: number): void;
}

export function createMainLoop(deps: MainLoopDeps): MainLoop {
  let scheduler: ReturnType<typeof createScheduler> | null = null;
  let lastTickAt = 0;
  let tickCount = 0;
  let currentEmotion: 'idle' | 'thinking' | 'talking' | 'waiting' = 'idle';

  // ── Spec 2C-1: Plan store + runner (one per main-loop) ──
  const planRepo: PlanRepo = createPlanStore(deps.db);
  const planRunner = createPlanRunner(planRepo);

  // ── Spec 2D: persistent main loop services ──
  const preferenceStore: PreferenceStore = createPreferenceStore(deps.db);
  const preferenceLearner: PreferenceLearner = createPreferenceLearner({
    store: preferenceStore,
    llm: deps.llmProvider ?? {
      complete: async () => {
        throw new Error('No LLM provider configured for preference learning. Pass deps.llmProvider.');
      },
    },
  });
  const reminderService: ReminderService = createReminderService(deps.db);
  const proactiveDetector: ProactiveDetector = createProactiveDetector({
    broadcast: (env) => deps.broadcast(env),
    reminderSvc: reminderService,
  });
  const idleScheduler: IdleScheduler = createIdleScheduler({
    intervalMs: deps.idleIntervalMs,
  });

  // ── Spec 1 W3: Reflection engine — 反思循环 ─────────────────
  // 异步 LLM 评估最近 N 轮是否高效, 写入 memory/thought (kind: 'reflection'),
  // 不阻塞主循环。失败静默, force-await 5s。
  // Spec 1 集成 memory: 用 ThoughtRepo.put(kind='reflection') 持久化。
  // 同时记录最近 N 条 envelope 用于 ReflectCtx。
  const reflectEngine: ReflectionEngine = createReflectionEngine({
    llm: deps.llmProvider ?? {
      complete: async () => {
        throw new Error('No LLM provider configured for reflection. Pass deps.llmProvider.');
      },
    },
    emit: (env) => deps.broadcast(env),
    writeThought: async (text, kind) => {
      // 写入 memory/thought。memory 持久化由 memoryService 负责。
      // Spec 1 W3 不强依赖现有 MemoryRepo 接口, 这里直接插入。
      // 真实接入 (W4) 会用 createMemoryRepositories(deps.db).thoughts.put(...)
      // 现在用占位 id, 待记忆层接入后改。
      try {
        const now = Date.now();
        deps.db.prepare(
          `INSERT OR IGNORE INTO thoughts (id, parent_id, kind, content, confidence, created_at)
           VALUES (?, NULL, ?, ?, ?, ?)`
        ).run(`reflection-${now}-${Math.random().toString(36).slice(2, 8)}`, kind, text, 0.7, now);
      } catch {
        // 静默 — 反思不该因为存储问题挂掉
      }
      return `reflection-${Date.now()}`;
    },
    cooldownMs: deps.reflectCooldownMs ?? DEFAULT_REFLECT_COOLDOWN_MS,
  });

  // 最近的 envelopes/tools/feedback ring buffer (反思 ReflectCtx 用)
  const REFLECT_CTX_CAPACITY = 50;
  const recentEnvelopes: UACSEnvelope[] = [];
  const recentTools: Array<{ name: string; ok: boolean; ms: number }> = [];
  const recentFeedback: Array<{ kind: 'allow' | 'deny' | 'nudge'; text?: string }> = [];
  // 错误时间戳环 (5min 窗口)
  const errorTimestamps: number[] = [];
  const ERROR_THRESHOLD_WINDOW_MS = 5 * 60 * 1000;
  const ERROR_THRESHOLD_COUNT = 5;
  let lastErrorReflectAt = 0;

  // ── Phase 6 (Task 6): pending permission requests ────────────────
  // envId → resolver; entries are added when gate says "ask" and removed
  // when the user resolves via resolvePermission() or the timeout fires.
  const pendingPermissions = new Map<string, (decision: 'allow' | 'deny', reason?: string) => void>();
  // envId → timer handle so we can clearTimeout on resolve and on stop().
  const permissionTimers = new Map<string, NodeJS.Timeout>();
  const awarenessSubscribers = new Set<(env: UACSEnvelope) => void>();

  function buildAwarenessSnapshot(): AwarenessSnapshotPayload {
    // Phase B.1: return schema-shaped empty data; Phase B.2 will query db.
    // We do compute uptime and activeTasks from runtime state so the envelope
    // is meaningful from the first tick.
    const activeTasks = deps.hasActiveTask() ? 1 : 0;
    const mode = deps.isRateLimited()
      ? 'rate_limited'
      : deps.hasPendingUserMessage()
        ? 'responding'
        : deps.hasActiveTask()
          ? 'working'
          : 'idle';
    return {
      tasks: [],
      thoughts: [],
      status: {
        mode,
        uptime: Date.now() - deps.startedAtMs,
        activeTasks,
      },
      emotion: currentEmotion,
    };
  }

  function buildUpdate(
    kind: 'task' | 'thought' | 'status' | 'emotion',
    data: unknown
  ): AwarenessUpdatePayload {
    if (kind === 'emotion' && typeof data === 'string') {
      currentEmotion = data as 'idle' | 'thinking' | 'talking' | 'waiting';
    }
    return { kind, data } as AwarenessUpdatePayload;
  }

  function buildEnvelope(payload: AwarenessSnapshotPayload): UACSEnvelope {
    return {
      id: newId('awareness'),
      type: 'awareness.snapshot',
      sender: 'soul',
      recipient: 'electron',
      timestamp: Date.now(),
      correlationId: null,
      traceMeta: {},
      payload,
    };
  }

  function tick(): Promise<void> {
    lastTickAt = Date.now();
    tickCount += 1;
    const snap = buildAwarenessSnapshot();
    deps.broadcast(buildEnvelope(snap));
    return Promise.resolve();
  }

  scheduler = createScheduler({
    onTick: tick,
    reason: () => {
      if (deps.hasPendingUserMessage()) return 'user_message';
      if (deps.hasActiveTask()) return 'active_task';
      if (deps.awakeningTicks() < 10) return 'awakening';
      return 'idle';
    },
    getState: () => ({
      isRateLimited: deps.isRateLimited(),
      awakeningTicks: deps.awakeningTicks(),
      reminderDueMs: deps.reminderDueMs(),
    }),
  });

  // ── Phase 6 (Task 6): helpers ───────────────────────────────────

  /** Spec 1 W3: 把 envelope 推入 ring buffer (反思 ReflectCtx 用) */
  function recordEnvelope(env: UACSEnvelope): void {
    recentEnvelopes.push(env);
    if (recentEnvelopes.length > REFLECT_CTX_CAPACITY) recentEnvelopes.shift();
  }

  /** Spec 1 W3: 构造当前 ReflectCtx (供触发反思用) */
  function buildReflectCtx(): ReflectCtx {
    return {
      recentEnvelopes: recentEnvelopes.slice(-20),
      recentTools: recentTools.slice(-20),
      recentFeedback: recentFeedback.slice(-20),
    };
  }

  /** Spec 1 W3: 异步 fire-and-forget 触发反思 (不阻塞调用方) */
  function triggerReflectAsync(trigger: ReflectTrigger): void {
    void reflectEngine.maybeReflect(trigger, buildReflectCtx()).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[main-loop] reflect error:', err instanceof Error ? err.message : String(err));
    });
  }

  /** Spec 1 W3: 检查 5min 内是否超过 ERROR_THRESHOLD_COUNT 个错误, 是则触发反思 */
  function maybeReflectOnErrorThreshold(): void {
    const now = Date.now();
    // 清理窗口外
    while (errorTimestamps.length > 0 && now - errorTimestamps[0]! > ERROR_THRESHOLD_WINDOW_MS) {
      errorTimestamps.shift();
    }
    if (errorTimestamps.length >= ERROR_THRESHOLD_COUNT && now - lastErrorReflectAt > DEFAULT_REFLECT_COOLDOWN_MS) {
      lastErrorReflectAt = now;
      triggerReflectAsync({
        kind: 'error_threshold',
        windowSec: ERROR_THRESHOLD_WINDOW_MS / 1000,
        count: errorTimestamps.length,
      });
    }
  }

  /**
   * Broadcast an AwarenessEvent to the renderer. Reuses the same envelope
   * shape as snapshots so the renderer's awareness channel can switch on
   * `payload.kind` for permission.* and goal.* events.
   */
  function broadcastEvent(event: AwarenessEvent): UACSEnvelope {
    const env = {
      id: newId('awareness'),
      type: 'awareness.update',
      sender: 'soul',
      recipient: 'electron',
      timestamp: Date.now(),
      correlationId: null,
      traceMeta: {},
      payload: event,
    } as unknown as UACSEnvelope;
    deps.broadcast(env);
    for (const subscriber of awarenessSubscribers) {
      try {
        subscriber(env);
      } catch (err) {
        console.error('[main-loop] awareness subscriber failed:', err);
      }
    }
    // Spec 1 W3: 记录到反思 ring buffer
    recordEnvelope(env);
    return env;
  }

  function buildToolDescriptor(toolDef: ToolDefinition): ToolDescriptor {
    return {
      name: toolDef.name,
      displayName: toolDef.displayName,
      displayDescription: toolDef.displayDescription,
      risk: toolDef.risk,
    };
  }

  async function gateToolCall(
    toolDef: ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const settings = loadSettings();
    const decision = evaluate({
      tool: toolDef.name,
      args,
      mode: settings.mode,
      rules: settings.rules,
      toolDescriptor: buildToolDescriptor(toolDef),
    });

    if (decision.kind === 'allow' || decision.kind === 'deny') {
      return decision;
    }

    // decision.kind === 'ask' — broadcast request and wait for user
    const env = broadcastEvent({
      kind: 'permission.request',
      tool: toolDef.name,
      reason: decision.reason,
    });

    const timeoutMs = (settings.permissionTimeoutSeconds ?? 60) * 1000;

    return new Promise<PermissionDecision>((resolve) => {
      const resolver = (d: 'allow' | 'deny', reason?: string) => {
        const timer = permissionTimers.get(env.id);
        if (timer) {
          clearTimeout(timer);
          permissionTimers.delete(env.id);
        }
        pendingPermissions.delete(env.id);
        if (d === 'allow') {
          broadcastEvent({ kind: 'permission.resolved', decision: 'allow' });
          resolve({ kind: 'allow' });
        } else {
          broadcastEvent({ kind: 'permission.resolved', decision: 'deny' });
          resolve({ kind: 'deny', reason: reason ?? 'Denied by user' });
        }
      };
      pendingPermissions.set(env.id, resolver);

      const timer = setTimeout(() => {
        if (!pendingPermissions.has(env.id)) return;
        broadcastEvent({ kind: 'permission.timeout', tool: toolDef.name });
        // Default-deny on timeout (safer than auto-allow)
        pendingPermissions.delete(env.id);
        permissionTimers.delete(env.id);
        resolve({ kind: 'deny', reason: `Permission timeout after ${settings.permissionTimeoutSeconds ?? 60}s` });
      }, timeoutMs);
      // Don't keep the Node process alive just for this timer
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      permissionTimers.set(env.id, timer);
    });
  }

  function resolvePermission(envelopeId: string, decision: 'allow' | 'deny'): boolean {
    const resolver = pendingPermissions.get(envelopeId);
    if (!resolver) return false; // unknown / already-resolved
    resolver(decision);
    return true;
  }

  async function runGoalMode(
    userInput: string,
    ctx: AgentContext,
    llm: LLMProvider,
  ): Promise<Goal | null> {
    const settings = loadSettings();
    // Both conditions required (per brief Step 4)
    if (settings.mode !== 'goal') return null;
    if (!userInput.includes('目标:')) return null;

    const goal = parseGoal(userInput);
    broadcastEvent({ kind: 'goal.started', goalId: goal.id, statement: goal.statement });

    // Spec 2A I2: verifier try/catch moved into goal.ts runGoalLoop itself.
    // No more runGoalLoopWithVerifierGuard mirror — single source of truth.
    const final = await runGoalLoop(goal, ctx, llm, (g) => {
      broadcastEvent({ kind: 'goal.iteration', goalId: g.id, iter: g.iterations });
    });

    broadcastEvent({
      kind: final.status === 'complete' ? 'goal.complete' : 'goal.aborted',
      goalId: final.id,
    });
    // Spec 1 W3: 目标完成后触发反思 (异步, 不阻塞)
    if (final.status === 'complete') {
      triggerReflectAsync({ kind: 'goal_complete', goalId: final.id });
    }
    return final;
  }

  /**
   * Spec 2C-1: Plan mode entry.
   *
   * 流程:
   *   1. settings.mode === 'plan' && 输入含 '目标:' 才走这个分支
   *   2. parseGoal → Goal
   *   3. LLM-based planFromGoal 拆 plan (失败回退到 parsePlanFromGoal)
   *   4. 持久化 + emit plan.created
   *   5. PlanRunner.runPlan 串行执行
   *   6. emit plan.completed | plan aborted
   */
  async function runPlanMode(
    userInput: string,
    ctx: AgentContext,
    llm: LLMProvider,
  ): Promise<Plan | null> {
    const settings = loadSettings();
    if (settings.mode !== 'plan') return null;
    if (!userInput.includes('目标:')) return null;

    const goal = parseGoal(userInput);
    broadcastEvent({ kind: 'goal.started', goalId: goal.id, statement: goal.statement });

    // 1. 拆 plan: 优先 LLM, 失败兜底 parser
    let plan: Plan;
    try {
      plan = await planFromGoal(goal, llm);
    } catch (err) {
      console.warn('[plan-mode] LLM planner failed, falling back to parser:', err instanceof Error ? err.message : String(err));
      plan = parsePlanFromGoal(goal);
    }

    // 2. 持久化
    const stored = planRepo.createPlan(plan);
    broadcastEvent({ kind: 'plan.created', plan: stored });

    // 3. 跑 plan — 把 AgentContext 适配为 RunnerContext
    const runnerCtx: RunnerContext = {
      runStep: async (step, _p) => {
        // 复用 AgentContext.runOnce, 但用 step.description 作为 contextSummary 的引导
        const augmentedGoal: Goal = { ...goal, contextSummary: `执行步骤: ${step.description}` };
        return await ctx.runOnce(augmentedGoal);
      },
      isAborted: () => ctx.isAborted(),
    };

    const final = await planRunner.runPlan(stored, runnerCtx, llm, (event: PlanEvent) => {
      // 把 runner 事件桥接到 awareness
      switch (event.kind) {
        case 'plan.step_started':
          broadcastEvent(event);
          break;
        case 'plan.step_completed':
          broadcastEvent(event);
          break;
        case 'plan.replanned':
          broadcastEvent(event);
          break;
        case 'plan.completed':
          broadcastEvent(event);
          break;
      }
    });

    broadcastEvent({
      kind: final.status === 'completed' ? 'goal.complete' : 'goal.aborted',
      goalId: goal.id,
    });
    // Spec 1 W3: 计划完成后触发反思 (异步, 不阻塞)
    if (final.status === 'completed') {
      triggerReflectAsync({
        kind: 'plan_completed',
        planId: final.id,
        durationMs: Date.now() - stored.created_at,
      });
    }
    return final;
  }

  /**
   * Spec 2C-1: 断点续跑入口.
   */
  async function resumePlan(
    planId: string,
    ctx: AgentContext,
    llm: LLMProvider,
  ): Promise<Plan | null> {
    const runnerCtx: RunnerContext = {
      runStep: async (step, _p) => {
        // resume 时没有原始 goal, 走一个 minimal stub
        const stubGoal: Goal = {
          id: 'resume',
          statement: `Resume step: ${step.description}`,
          acceptance: [],
          status: 'running',
          iterations: 0,
          started_at: Date.now(),
          contextSummary: '',
        };
        return await ctx.runOnce(stubGoal);
      },
      isAborted: () => ctx.isAborted(),
    };

    return await planRunner.resumePlan(planId, runnerCtx, llm, (event: PlanEvent) => {
      broadcastEvent(event);
    });
  }

  return {
    start() {
      // MCP W5: 启动 mcp server + 注册 tools (一次, before scheduler)
      if (deps.mcpRegistry) {
        void deps.mcpRegistry.start()
          .then(() => {
            if (deps.toolRegistry) deps.mcpRegistry!.registerToolsTo(deps.toolRegistry);
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[main-loop] mcp start failed:', err instanceof Error ? err.message : String(err));
          });
      }
      scheduler?.start();
      // Spec 2D: 启动 idle scheduler + 注册内置 task.
      // 注意 reminder 检查频率独立 (默认 30s), 区别于 idle 5min 周期.
      idleScheduler.start();
      idleScheduler.register(
        () => {
          // spec 2D: 每 N 秒检查过期 reminder → 主动推送
          try {
            proactiveDetector.checkDueReminders();
          } catch (err) {
            console.error('[main-loop] checkDueReminders error:', err);
          }
        },
        {
          name: 'check-due-reminders',
          intervalMs: deps.reminderIntervalMs,
        },
      );
      // Task 4.1: idle heartbeat → awareness.snapshot.
      // 每 idleIntervalMs (默认 5min) 主动 broadcast 一次完整 snapshot,
      // 让 renderer 在长 idle 后能看到 agent 的当前状态 (mode/uptime/emotion).
      // 不走 scheduler.start() 是因为 scheduler 是 priority-adaptive tick
      // (user_message/active_task/awakening/idle),idle 阶段不会自然 tick;
      // 需要独立的周期性广播才能保证 idle 时也有 snapshot 流动.
      idleScheduler.register(
        () => {
          try {
            deps.broadcast(buildEnvelope(buildAwarenessSnapshot()));
          } catch (err) {
            console.error('[main-loop] awareness-heartbeat error:', err);
          }
        },
        {
          name: 'awareness-heartbeat',
          intervalMs: deps.idleIntervalMs,
        },
      );
      // Spec 1 W3: idle 反思 — 每 idle 周期 (默认 5min) 检查错误超阈,
      // 触发反思 (异步, 不阻塞 scheduler)。
      idleScheduler.register(
        () => {
          try {
            maybeReflectOnErrorThreshold();
          } catch (err) {
            console.error('[main-loop] reflect-on-error error:', err);
          }
        },
        {
          name: 'reflect-on-error-threshold',
          intervalMs: deps.idleIntervalMs,
        },
      );
      // DISABLED: 现阶段 (v1) 不主动调用，避免注册空回调占用 slot。
      // 保留 provider 分支的行为不再注册偏好学习任务；对话处理器通过
      // applyUserMessageForLearning() 触发学习。
    },
    stop() {
      scheduler?.stop();
      // Spec 2D: 停止 idle scheduler, 清理 timers.
      idleScheduler.stop();
      // MCP W5: 优雅 kill 所有 mcp server 子进程.
      if (deps.mcpRegistry) {
        void deps.mcpRegistry.shutdown().catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[main-loop] mcp shutdown failed:', err instanceof Error ? err.message : String(err));
        });
      }
      // H14: resolve all pending permission requests with deny so callers
      // don't hang forever after stop().
      for (const timer of permissionTimers.values()) clearTimeout(timer);
      permissionTimers.clear();
      for (const resolver of pendingPermissions.values()) {
        resolver('deny', 'stopped');
      }
      pendingPermissions.clear();
      awarenessSubscribers.clear();
    },
    triggerUserMessage() {
      void scheduler?.triggerImmediateTick('user_message');
    },
    getSnapshot() {
      return buildAwarenessSnapshot();
    },
    buildUpdate,
    getState() {
      const reason: TickReason = deps.hasPendingUserMessage()
        ? 'user_message'
        : deps.hasActiveTask()
          ? 'active_task'
          : deps.awakeningTicks() < 10
            ? 'awakening'
            : 'idle';
      return { lastTickAt, tickCount, reason };
    },
    subscribeAwareness(handler) {
      awarenessSubscribers.add(handler);
      return () => awarenessSubscribers.delete(handler);
    },
    gateToolCall,
    resolvePermission,
    runGoalMode,
    runPlanMode,
    resumePlan,
    getPlanRepo: () => planRepo,
    // ── Spec 2D accessors ──
    getReminderService: () => reminderService,
    getPreferenceStore: () => preferenceStore,
    getProactiveDetector: () => proactiveDetector,
    getIdleScheduler: () => idleScheduler,
    async applyUserMessageForLearning(userMessage, assistantReply) {
      if (!deps.llmProvider) return 0;  // 无 LLM, 静默
      try {
        return await preferenceLearner.learnFromMessage(userMessage, assistantReply);
      } catch (err) {
        console.error('[main-loop] preference learning error:', err);
        return 0;
      }
    },
    applyExplicitPreference(key, value) {
      preferenceLearner.applyExplicit(key, value);
    },
    // ── Spec 1 W3 accessors ──
    getReflectionEngine: () => reflectEngine,
    recordErrorEvent() {
      errorTimestamps.push(Date.now());
      // 立即尝试触发 (供测试 / 实时用)
      maybeReflectOnErrorThreshold();
    },
    recordToolResult(name, ok, ms) {
      recentTools.push({ name, ok, ms });
      if (recentTools.length > REFLECT_CTX_CAPACITY) recentTools.shift();
    },
  };
}