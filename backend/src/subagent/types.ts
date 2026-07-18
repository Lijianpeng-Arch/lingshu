/**
 * Sub-agent 类型定义 — 灵枢 V2 Spec 2C-2
 *
 * 借鉴:
 *   - Manus `subagent_pool.py` (SubAgentTask 结构 + 父子关联)
 *   - Devin `worker.py` (timeout_ms, allowed_tools 限制)
 *   - LangGraph `Send()` primitive (并行 fan-out 的最小数据单元)
 *   - CrewAI `Agent(role, allow_delegation=True)` (子代理隔离)
 *
 * 设计要点:
 *   - SubAgentTask 是 fork 时的输入 (不可变快照)
 *   - SubAgentResult 是执行后产物 (无论 ok/fail 都返回)
 *   - SubAgentStatus 显式枚举, 避免字符串漂移
 *   - ToolCall 抽象独立, 不绑具体工具实现 (sub-agent 可以用任意 tool)
 *   - parent_goal_id / parent_step_id 串起调用栈, 便于审计
 */

export type SubAgentStatus =
  | 'spawned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout';

/**
 * 子 agent 单次工具调用记录.
 * 借 Manus `tool_call.py`: 子 agent 用过的工具全部记录, 便于审计 + 错误回放.
 */
export interface ToolCall {
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
  started_at: number;
  completed_at?: number;
}

/**
 * Sub-agent 任务 — fork 时的输入快照.
 *
 * 字段说明:
 *   - id            任务唯一 id, 由 caller 生成 (用于追踪 + 消息路由)
 *   - prompt        子 agent 的输入 prompt (它的"目标")
 *   - parent_goal_id 父 goal id (审计回溯)
 *   - parent_step_id 父 step id (哪个 PlanStep fork 了它)
 *   - allowed_tools 白名单 (空数组 = 不限制, 推荐至少给一个保护)
 *   - timeout_ms    deadline, 0 = 不限时 (但 caller 应尽量设上限)
 */
export interface SubAgentTask {
  id: string;
  prompt: string;
  parent_goal_id: string;
  parent_step_id: string;
  allowed_tools?: string[];
  timeout_ms: number;
}

/**
 * Sub-agent 执行结果.
 *
 * ok=true → output 有意义; ok=false → error 有意义.
 * duration_ms 始终记录 (即便超时也记录"撑了多久").
 * tool_calls 包含所有调用 (成功 + 失败), 给 caller 决定如何 merge.
 */
export interface SubAgentResult {
  task_id: string;
  ok: boolean;
  output?: string;
  error?: string;
  tool_calls: ToolCall[];
  duration_ms: number;
  /** 最终状态 (completed/failed/timeout), 与 ok 冗余但便于快速判定 */
  status: SubAgentStatus;
}

/**
 * Sub-agent 上下文 — 给执行器使用 (隔离父子的工具/记忆/权限).
 *
 * 借鉴 Devin `worker.py`: 子 agent 不应直接继承父的全部 context,
 * 而是通过 SubAgentContext 显式注入"它能看到/能用的东西".
 */
export interface SubAgentContext {
  goal_id: string;
  step_id: string;
  allowed_tools: string[];
  /** 子 agent 与父的通信总线 (类型由 message-bus.ts 提供, 在 index.ts 聚合) */
  bus: import('./message-bus.js').SubAgentMessageBus;
}

/**
 * 子 agent 执行函数签名 — 由 runner.ts 提供具体实现,
 * 测试可以注入 mock.
 */
export type SubAgentExecutor = (
  task: SubAgentTask,
  ctx: SubAgentContext,
) => Promise<SubAgentResult>;