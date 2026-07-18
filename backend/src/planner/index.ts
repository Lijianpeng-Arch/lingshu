/**
 * Planner — LLM-based plan decomposition
 * 灵枢 V2 Spec 2C-1
 *
 * 借鉴:
 *   - Manus `task_planner.py` (LLM 拆解 + JSON schema)
 *   - Devin `planner.py` (step description + optional acceptance)
 *
 * 行为:
 *   - 输入: Goal (statement + acceptance) + LLMProvider
 *   - 输出: Plan (3-5 步), 所有 step status='pending'
 *   - 失败: LLM 返回不可解析 → 抛错 (由 caller 决定是否 fallback 到 parser)
 *
 * 设计:
 *   - 提示词明确要"输出 JSON, 3-5 步, 每步 description"
 *   - 不强制接受 acceptance, 步骤可能更细 (因为一个 acceptance 可能要分几步)
 *   - 复用 verifier.ts 的 LLMProvider 接口 (complete({ prompt, json }))
 */

import type { Plan, PlanStep } from '../plan/types.js';
import type { Goal } from '../agent/goal.js';
import type { LLMProvider } from '../agent/verifier.js';
import { newPlanId, newStepId } from '../plan/parser.js';

/** LLM 输出的 schema (解析时仅取 description, 防御式解析) */
interface LLMDecomposeResponse {
  steps: Array<{ description: string; acceptance?: string[] }>;
}

/**
 * Planner 配置 — 给上层注入 (e.g. max steps 上限, temperature)
 */
export interface PlannerConfig {
  /** 最少步数 (默认 3, spec 要求 3-5 步) */
  minSteps?: number;
  /** 最多步数 (默认 5) */
  maxSteps?: number;
}

const DEFAULT_CONFIG: Required<PlannerConfig> = {
  minSteps: 3,
  maxSteps: 5,
};

/**
 * 用 LLM 把 Goal 拆成 N 步 plan.
 *
 * 异常:
 *   - LLM.complete 返回非 JSON → throw new Error (caller 兜底)
 *   - LLM 返回的 steps 数量 < minSteps → throw (caller 兜底)
 *   - 任何 throw 都不会破坏现有 plan (caller 可决定 fallback 到 parsePlanFromGoal)
 */
export async function planFromGoal(
  goal: Goal,
  llm: LLMProvider,
  config: PlannerConfig = {},
): Promise<Plan> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const prompt = `你是一个任务规划师. 基于以下目标 + 验收清单, 拆成 ${cfg.minSteps}-${cfg.maxSteps} 个可执行步骤.

目标: ${goal.statement}

验收清单:
${goal.acceptance.map((c, i) => `${i + 1}. ${c.text}`).join('\n') || '(无)'}

每个步骤应是:
- 1 个明确可执行的动作 (例: "读 foo.ts 文件", "修改 bar 函数", "运行测试")
- 步骤之间按顺序, 前一步是后一步的前提
- 可以包含该步骤自己的小验收 (可选)

输出 JSON:
{
  "steps": [
    { "description": "...", "acceptance": ["..."] },
    ...
  ]
}`;

  const resp = await llm.complete({ prompt, json: true });
  const parsed = JSON.parse(resp.text) as Partial<LLMDecomposeResponse>;
  const rawSteps = parsed.steps ?? [];

  if (rawSteps.length < cfg.minSteps) {
    throw new Error(
      `planner: LLM returned ${rawSteps.length} steps, expected >= ${cfg.minSteps}`,
    );
  }

  // 截断超出 maxSteps 的步骤 (防御)
  const truncated = rawSteps.slice(0, cfg.maxSteps);

  const steps: PlanStep[] = truncated.map((s) => ({
    id: newStepId(),
    description: String(s.description ?? '').trim() || '(未描述步骤)',
    status: 'pending',
    retries: 0,
    acceptance: Array.isArray(s.acceptance)
      ? s.acceptance.map(a => String(a))
      : undefined,
  }));

  const now = Date.now();
  return {
    id: newPlanId(),
    goal_id: goal.id,
    steps,
    created_at: now,
    updated_at: now,
    status: 'draft',
    current_step_index: 0,
    replan_count: 0,
  };
}