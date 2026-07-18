/**
 * Sub-agent Message Bus — 父子消息传递
 * 灵枢 V2 Spec 2C-2
 *
 * 借鉴:
 *   - LangGraph Send() primitive (sub-graph 之间用 channel 通信)
 *   - CrewAI before/after agent hooks (事件广播机制)
 *   - 灵枢自身 awareness event bus (类型化 emit + 订阅)
 *
 * 设计:
 *   - bus 是 in-memory pub/sub (子 agent 进程内, 不跨进程)
 *   - 3 类消息: spawn / progress / complete (与 spec §2.2 对齐)
 *   - 父可以订阅 child 完成事件 (用于 barrier)
 *   - 子可以给父发 progress (心跳/日志)
 *   - 不做持久化 — bus 在 sub-agent 结束时清理
 */

import type { SubAgentResult } from './types.js';

export type SubAgentMessage =
  | { kind: 'spawn'; task_id: string; subagent_id: string; ts: number }
  | { kind: 'progress'; subagent_id: string; task_id: string; status: string; ts: number }
  | { kind: 'complete'; subagent_id: string; task_id: string; result: SubAgentResult; ts: number };

export interface SubAgentMessageBus {
  /** 发送消息 (内部使用) */
  emit(msg: SubAgentMessage): void;
  /** 订阅某 subagent_id 的 complete 消息, 返回 Promise (await 完成即 resolve) */
  awaitComplete(subagentId: string): Promise<SubAgentMessage>;
  /** 列出某 task 的所有 spawn 消息 (调试/审计) */
  historyForTask(taskId: string): SubAgentMessage[];
  /** 全部消息历史 (顺序) */
  history(): SubAgentMessage[];
  /** 关闭 bus, 清理所有监听器 */
  close(): void;
}

export function createSubAgentMessageBus(): SubAgentMessageBus {
  const messages: SubAgentMessage[] = [];
  // subagent_id → waiters
  const completeWaiters = new Map<string, Array<(m: SubAgentMessage) => void>>();

  function emit(msg: SubAgentMessage): void {
    messages.push(msg);
    if (msg.kind === 'complete') {
      const waiters = completeWaiters.get(msg.subagent_id);
      if (waiters) {
        for (const resolve of waiters) resolve(msg);
        completeWaiters.delete(msg.subagent_id);
      }
    }
  }

  function awaitComplete(subagentId: string): Promise<SubAgentMessage> {
    // 如果历史里已有 complete, 立即返回
    const past = messages.find(
      (m): m is Extract<SubAgentMessage, { kind: 'complete' }> =>
        m.kind === 'complete' && m.subagent_id === subagentId,
    );
    if (past) return Promise.resolve(past);

    return new Promise((resolve) => {
      const list = completeWaiters.get(subagentId) ?? [];
      list.push(resolve as (m: SubAgentMessage) => void);
      completeWaiters.set(subagentId, list);
    });
  }

  function historyForTask(taskId: string): SubAgentMessage[] {
    return messages.filter((m) => 'task_id' in m && m.task_id === taskId);
  }

  function history(): SubAgentMessage[] {
    return messages.slice();
  }

  function close(): void {
    completeWaiters.clear();
    // 不清 messages — 父进程可能在 close 后还想查 history
  }

  return { emit, awaitComplete, historyForTask, history, close };
}