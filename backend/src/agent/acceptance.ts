/**
 * Acceptance Criterion — 目标模式验收清单核心数据结构
 * 灵枢 V2 — Goal 系统
 *
 * 借鉴思路：Hermes 的 convergence.ts 把"是否完成"拆为可枚举的布尔清单
 *           (而不是单一标量)，灵枢同样把验收拆为 N 条独立布尔，方便局部补完。
 */

export interface AcceptanceCriterion {
  /** 验收条目原文（人类可读） */
  text: string;
  /** 验证后赋值：true 通过 / false 不通过 / undefined 尚未验证 */
  passed?: boolean;
  /** 通过或不通过的证据（来自 LLM verifier 的原文理由） */
  evidence?: string;
}

/**
 * 解析验收清单文本。支持格式:
 *   - "1) xxx\n2) yyy" (numbered)
 *   - "- xxx\n- yyy" (dash)
 *   - "* xxx\n* yyy" (asterisk)
 * 解析时 stripped 前缀（数字/横线/星号）和空白。
 */
export function parseAcceptance(input: string): AcceptanceCriterion[] {
  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  return lines
    .map(l => l.replace(/^(\d+\)|-|\*)\s*/, '').trim())
    .filter(text => text.length > 0)
    .map(text => ({ text }));
}

/**
 * 判断验收清单是否全部通过。空数组按"真空成立"返回 true（无验收标准 = 默认通过）。
 * 任何未定义 passed 的条目视为不通过（防止漏检）。
 */
export function allPassed(criteria: AcceptanceCriterion[]): boolean {
  return criteria.every(c => c.passed === true);
}