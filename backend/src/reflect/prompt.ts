/**
 * Reflect — 中文反思 prompt 模板
 *
 * 灵枢 V2 — Spec 1 反思循环 (W3)
 *
 * 让 LLM 用中文评估最近 N 轮操作的效率, 返回结构化 JSON:
 *   - hypothesis: 当时假设的策略
 *   - action:     当时采取的动作
 *   - evidence:   引用具体证据 (envelope id / tool 结果)
 *   - verdict:    efficient | wasteful | wrong | unclear
 *   - correction: 当 verdict !== efficient 时的修正建议
 */

import type { ReflectCtx, ReflectTrigger } from './types.js';

/** 把 trigger 转中文描述, 嵌入 prompt 上下文 */
export function describeTrigger(trigger: ReflectTrigger): string {
  switch (trigger.kind) {
    case 'goal_complete':
      return `目标完成 (goalId: ${trigger.goalId})`;
    case 'plan_completed':
      return `计划完成 (planId: ${trigger.planId}, 用时 ${trigger.durationMs}ms)`;
    case 'idle':
      return `空闲触发 (已空闲 ${trigger.idleMinutes} 分钟)`;
    case 'error_threshold':
      return `错误超阈 (${trigger.windowSec}s 内出现 ${trigger.count} 个错误)`;
  }
}

/** 把 envelope 列表压平成可读字符串 (id + type + 关键字段) */
function formatEnvelopes(ctx: ReflectCtx): string {
  if (ctx.recentEnvelopes.length === 0) return '(无)';
  return ctx.recentEnvelopes
    .map((env) => {
      const payload = env.payload as { kind?: string; tool?: string; reason?: string } | undefined;
      const tag = payload?.kind ? `[${payload.kind}]` : `[${env.type}]`;
      const detail = payload?.tool ? ` tool=${payload.tool}` : '';
      return `- ${env.id} ${tag}${detail}`;
    })
    .join('\n');
}

/** 工具调用列表 → 字符串 */
function formatTools(ctx: ReflectCtx): string {
  if (ctx.recentTools.length === 0) return '(无)';
  return ctx.recentTools
    .map((t) => `- ${t.name} ${t.ok ? 'OK' : 'FAIL'} (${t.ms}ms)`)
    .join('\n');
}

/** 反馈列表 → 字符串 */
function formatFeedback(ctx: ReflectCtx): string {
  if (ctx.recentFeedback.length === 0) return '(无)';
  return ctx.recentFeedback
    .map((f) => `- ${f.kind}${f.text ? `: ${f.text}` : ''}`)
    .join('\n');
}

/**
 * 构造完整的中文反思 prompt。
 * 调用方负责传入 JSON 解析 (json: true) 的 LLM。
 */
export function buildReflectPrompt(trigger: ReflectTrigger, ctx: ReflectCtx): string {
  return `你是一个自我反思引擎。请基于最近的操作记录评估自己的策略是否高效。

触发原因: ${describeTrigger(trigger)}

最近 N 轮 envelope:
${formatEnvelopes(ctx)}

最近工具调用:
${formatTools(ctx)}

最近反馈:
${formatFeedback(ctx)}

请评估 (输出 JSON):
1. hypothesis: 你当时假设的策略是什么
2. action:     你采取了什么动作
3. evidence:   引用具体证据 (envelope id / tool 结果)
4. verdict:    efficient | wasteful | wrong | unclear
5. correction: 如果 verdict != efficient, 给出修正建议

返回严格 JSON:
{
  "hypothesis": "...",
  "action": "...",
  "evidence": ["..."],
  "verdict": "efficient|wasteful|wrong|unclear",
  "correction": "..."  // 可选
}`;
}