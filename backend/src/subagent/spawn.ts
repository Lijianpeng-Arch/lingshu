/**
 * Sub-agent Spawn — fork + 生命周期管理
 * 灵枢 V2 Spec 2C-2
 *
 * 借鉴:
 *   - Manus `subagent_pool.py` (fork task, track state)
 *   - Devin `worker.py` (timeout + cleanup)
 *   - LangGraph `Send()` primitive (fan-out 控制)
 *
 * 设计:
 *   - spawn(task) 返回 SubAgentHandle (含 subagent_id, 用于追踪)
 *   - 内部: race(executor, timeout) — 谁先到用谁
 *   - timeout 命中 → result.ok=false, status='timeout', 仍然 emit complete
 *   - executor throw → result.ok=false, status='failed'
 *   - executor 正常返回 → result 透传, status='completed'
 *
 * 注意: spawn 不会抛错 (除非 task 字段缺失). 失败/超时都用 SubAgentResult 表达.
 * 这样父可以并行 spawn N 个, 用 Promise.all 收集, 不会因为一个 timeout 拖垮全部.
 */

import { randomUUID } from 'node:crypto';
import type {
  SubAgentTask,
  SubAgentResult,
  SubAgentContext,
  SubAgentStatus,
  SubAgentExecutor,
} from './types.js';
import type { SubAgentMessageBus } from './message-bus.js';
import { createSubAgentMessageBus } from './message-bus.js';
import type { AwarenessEvent } from '../agent/awareness.js';

export interface SubAgentHandle {
  subagent_id: string;
  task: SubAgentTask;
  /** 完成的 Promise — caller 用 Promise.all 收集 */
  done: Promise<SubAgentResult>;
  /** 关联的 message bus (sub-agent 完成/失败后 caller 可清理) */
  bus: SubAgentMessageBus;
  /** cancel 函数 — 提前结束 (用于 abort 场景) */
  cancel: () => void;
}

export interface SpawnOptions {
  /** 注入执行器 (测试用), 默认使用 runner.ts 提供的实现 */
  executor?: SubAgentExecutor;
  /** 注入 bus (测试用), 默认创建新 bus */
  bus?: SubAgentMessageBus;
  /** 广播到 awareness bus，供 renderer 观察子 agent 生命周期。 */
  awareness?: (event: AwarenessEvent) => void;
  /** 子 agent 的描述；未传则使用 task.prompt。 */
  description?: string;
  /** 子 agent 的 subagent_id (测试用, 默认自动生成) */
  subagentId?: string;
}

/**
 * Fork 一个子 agent.
 *
 * 立即返回 handle, 不阻塞. handle.done 是异步的.
 * 调用方通常:
 *   const handles = tasks.map(t => spawn(t, { executor }));
 *   const results = await Promise.all(handles.map(h => h.done));
 */
export function spawn(task: SubAgentTask, opts: SpawnOptions = {}): SubAgentHandle {
  // 防御: 必要字段
  if (!task.id) throw new Error('[spawn] task.id is required');
  if (!task.parent_goal_id) throw new Error('[spawn] task.parent_goal_id is required');
  if (!task.parent_step_id) throw new Error('[spawn] task.parent_step_id is required');
  if (typeof task.prompt !== 'string') throw new Error('[spawn] task.prompt must be a string');

  const subagent_id = opts.subagentId ?? `sa_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const bus = opts.bus ?? createSubAgentMessageBus();
  const executor = opts.executor ?? defaultExecutor;

  // 发送 spawn 消息 (bus 记录)
  bus.emit({ kind: 'spawn', task_id: task.id, subagent_id, ts: Date.now() });
  bus.emit({ kind: 'progress', subagent_id, task_id: task.id, status: 'spawned', ts: Date.now() });
  opts.awareness?.({
    kind: 'subagent.spawned',
    subagent_id,
    task_id: task.id,
    parent_goal_id: task.parent_goal_id,
    description: opts.description ?? task.prompt,
  });

  const ctx: SubAgentContext = {
    goal_id: task.parent_goal_id,
    step_id: task.parent_step_id,
    allowed_tools: task.allowed_tools ?? [],
    bus,
  };

  const startedAt = Date.now();
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;

  const done = (async (): Promise<SubAgentResult> => {
    // 状态: running
    bus.emit({ kind: 'progress', subagent_id, task_id: task.id, status: 'running', ts: Date.now() });

    // race: executor vs timeout
    const execPromise = (async () => {
      if (cancelled) throw new Error('cancelled');
      return await executor(task, ctx);
    })();

    const timeoutMs = task.timeout_ms ?? 0;
    if (timeoutMs > 0) {
      const timeoutPromise = new Promise<SubAgentResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            task_id: task.id,
            ok: false,
            error: `timeout after ${timeoutMs}ms`,
            tool_calls: [],
            duration_ms: Date.now() - startedAt,
            status: 'timeout' as SubAgentStatus,
          });
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([execPromise, timeoutPromise]);
        if (timer) clearTimeout(timer);
        // emit complete
        bus.emit({ kind: 'complete', subagent_id, task_id: task.id, result, ts: Date.now() });
        opts.awareness?.({ kind: 'subagent.completed', subagent_id, task_id: task.id, result });
        return result;
      } catch (err) {
        if (timer) clearTimeout(timer);
        const result: SubAgentResult = {
          task_id: task.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          tool_calls: [],
          duration_ms: Date.now() - startedAt,
          status: 'failed',
        };
        bus.emit({ kind: 'complete', subagent_id, task_id: task.id, result, ts: Date.now() });
        opts.awareness?.({ kind: 'subagent.completed', subagent_id, task_id: task.id, result });
        return result;
      }
    } else {
      // 无超时
      try {
        const result = await execPromise;
        bus.emit({ kind: 'complete', subagent_id, task_id: task.id, result, ts: Date.now() });
        opts.awareness?.({ kind: 'subagent.completed', subagent_id, task_id: task.id, result });
        return result;
      } catch (err) {
        const result: SubAgentResult = {
          task_id: task.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          tool_calls: [],
          duration_ms: Date.now() - startedAt,
          status: 'failed',
        };
        bus.emit({ kind: 'complete', subagent_id, task_id: task.id, result, ts: Date.now() });
        opts.awareness?.({ kind: 'subagent.completed', subagent_id, task_id: task.id, result });
        return result;
      }
    }
  })();

  return {
    subagent_id,
    task,
    done,
    bus,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * 默认 executor — 占位实现.
 * 真实场景由 PlanRunner 注入 (见 subagent/runner.ts).
 * 这里仅用于 spawn 单元测试, 永远返回 ok=true.
 */
const defaultExecutor: SubAgentExecutor = async (task) => ({
  task_id: task.id,
  ok: true,
  output: `default-executor: ${task.prompt}`,
  tool_calls: [],
  duration_ms: 0,
  status: 'completed',
});