/**
 * Awareness — dispatcher handlers for `awareness.snapshot` / `awareness.update`,
 * plus the union of internal `AwarenessEvent` values broadcast by the agent.
 *
 * Phase B.1 handles inbound envelopes from the renderer:
 *   - `awareness.snapshot`  → on demand full snapshot for renderer refresh
 *   - `awareness.update`    → renderer-driven nudges (e.g. user behaviour hint)
 *
 * Outbound broadcast is owned by `main-loop.ts` (per-tick) — this file only
 * deals with the "renderer asks → agent answers" half of the channel.
 *
 * Phase 6 (Task 6): the union adds `permission.*` and `goal.*` events so the
 * renderer can show permission dialogs, soft-timeout prompts, and goal progress.
 *
 * Spec 2C-1: the union adds `plan.*` events (created/step_started/step_completed/
 * replanned/completed) so the renderer can show long-task plan progress.
 * These names are fixed contracts for 2C-2/2C-3 to depend on.
 *
 * Spec 2C-2: the union adds `subagent.spawned` / `subagent.completed` events so
 * the renderer can show parallel sub-agent fan-out (which agents are working
 * in parallel, when each finishes). These names are FIXED — UI (2C-3) consumes them.
 */

import type { MainLoop } from './main-loop.js';
import type { UACSEnvelope, UACSEnvelopeType } from '../uacs/envelope.js';
import type { Plan, PlanStep } from '../plan/types.js';
import type { SubAgentResult } from '../subagent/types.js';

export interface AwarenessDeps {
  mainLoop: MainLoop;
}

export type AwarenessHandler = (env: UACSEnvelope) => Promise<UACSEnvelope | void> | UACSEnvelope | void;

/**
 * AwarenessEvent — union of internal agent events emitted to the renderer.
 *
 * Existing kinds (Phase B) come from `main-loop.buildUpdate`:
 *   - `task` / `thought` / `status` / `emotion` updates
 *
 * New kinds (Phase 6 / Task 6):
 *   - `permission.request`    gate said "ask" → renderer pops permission card
 *   - `permission.resolved`   user answered (allow / deny) → UI closes
 *   - `permission.timeout`    user didn't answer in time → default-deny
 *   - `goal.started`          goal mode entered, id + statement for UI
 *   - `goal.iteration`        one step done, UI shows progress
 *   - `goal.complete`         verifier said allPassed → UI shows success
 *   - `goal.aborted`          user aborted or soft-timeout failed → UI shows stop
 *
 * Kept as a discriminated union (`kind`) so renderers can switch on it.
 */
export type AwarenessEvent =
  | { kind: 'permission.request'; tool: string; reason: string }
  | { kind: 'permission.resolved'; decision: 'allow' | 'deny' }
  | { kind: 'permission.timeout'; tool: string }
  | { kind: 'goal.started'; goalId: string; statement: string }
  | { kind: 'goal.iteration'; goalId: string; iter: number }
  | { kind: 'goal.complete'; goalId: string }
  | { kind: 'goal.aborted'; goalId: string }
  // Spec 2C-1 — Plan events. 命名固定, 2C-2/2C-3 会消费.
  | { kind: 'plan.created'; plan: Plan }
  | { kind: 'plan.step_started'; plan_id: string; step_id: string; step_index: number }
  | { kind: 'plan.step_completed'; plan_id: string; step_id: string; result: string }
  | { kind: 'plan.replanned'; plan_id: string; new_steps: PlanStep[] }
  | { kind: 'plan.completed'; plan_id: string; duration_ms: number }
  // Spec 2C-2 — Sub-agent events. 命名固定, UI (2C-3) 消费.
  // subagent.spawned: 一个 sub-agent 启动 (renderer 显示 fan-out 状态)
  // subagent.completed: 一个 sub-agent 完成/失败/超时 (renderer 更新状态)
  | {
      kind: 'subagent.spawned';
      subagent_id: string;
      task_id: string;
      parent_goal_id: string;
      description: string;
    }
  | {
      kind: 'subagent.progress';
      subagent_id: string;
      task_id: string;
      status: 'spawned' | 'running';
    }
  | {
      kind: 'subagent.completed';
      subagent_id: string;
      task_id: string;
      result: SubAgentResult;
    }
  // Spec 2D — Proactive events. 命名固定, 由 proactive/detector.ts 广播.
  // proactive.reminder: reminder 触发 → renderer 显示通知卡片
  // proactive.error: 检测到重要错误 → renderer 显示
  // proactive.task_completion: 计划任务完成汇报
  // proactive.insight: idle 学习到的洞察 (e.g. 偏好升级建议)
  | {
      kind: 'proactive.reminder';
      action: 'push';
      data: {
        id: string;
        message: string;
        user_input: string;
        trigger_at: number;
      };
    }
  | {
      kind: 'proactive.error';
      action: 'push';
      data: {
        kind: 'git_push_fail' | 'build_fail' | 'shell_fail';
        exit: number;
        stderr: string;
      };
    }
  | {
      kind: 'proactive.task_completion';
      action: 'summary';
      data: {
        source: string;
        plan_id?: string;
        goal_id?: string;
        duration_ms?: number;
      };
    }
  | {
      kind: 'proactive.insight';
      action: 'log' | 'push';
      data: Record<string, unknown>;
    }
  // Spec 1 W3 — Reflection events. 命名固定, 由 reflect/engine.ts 广播.
  // reflection.started:   反思开始 (LLM 调用前), renderer 可以显示"正在反思"指示
  // reflection.completed: 反思结束 (含 verdict 或 note=timeout-or-error/parse-failed)
  | { kind: 'reflection.started'; trigger: string }
  | { kind: 'reflection.completed'; verdict: string; note?: string };

/**
 * Wire awareness handlers into a dispatcher registry. The caller controls how
 * handlers are stored so the dispatcher stays free of agent-layer knowledge.
 */
export function registerAwarenessHandlers(
  deps: AwarenessDeps,
  register: (type: UACSEnvelopeType, handler: AwarenessHandler) => void,
): void {
  register('awareness.snapshot', async (env) => {
    const snap = deps.mainLoop.getSnapshot();
    return {
      ...env,
      type: 'awareness.snapshot',
      timestamp: Date.now(),
      payload: snap,
    } as UACSEnvelope;
  });

  register('awareness.update', async (env) => {
    // Phase B.1: log renderer-driven updates. Phase E will use these as
    // triggers for proactive actions (e.g. suggest a reminder).
    const payload = env.payload;
    if (payload && (payload as { kind?: unknown }).kind) {
      console.log('[awareness.update]', payload);
    }
    return {
      ...env,
      type: 'awareness.snapshot',
      timestamp: Date.now(),
      payload: { ack: true, ...(payload as object | undefined) },
    } as unknown as UACSEnvelope;
  });
}