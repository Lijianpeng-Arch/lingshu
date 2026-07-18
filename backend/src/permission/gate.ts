import type { PermissionRequest, PermissionDecision } from './types';
import { findMatchingRule } from './rules';

/** OpenCode permission/evaluate.ts 灵枢化：deny → allow → ask。 */
// Spec 2A I3 — alias scanning: borrow OpenCode parameter normalization
// pattern. Accept multiple key names so an LLM that picks cmd/exec/shell/bash
// instead of the canonical "command" still gets rule-matched.
function firstString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof args[k] === 'string') return args[k] as string;
  }
  return undefined;
}

export function evaluate(req: PermissionRequest): PermissionDecision {
  const { tool, args, mode, rules, toolDescriptor } = req;
  const pathArg = firstString(args, 'path', 'filePath', 'file', 'target');
  const cmdArg = firstString(args, 'command', 'cmd', 'exec', 'shell', 'script', 'bash');
  const messageArg = firstString(args, 'message', 'msg', 'text');

  const matchingRule = findMatchingRule(rules, tool, pathArg)
    ?? findMatchingRule(rules, tool, cmdArg);
  if (matchingRule?.action === 'deny') {
    return { kind: 'deny', reason: `Rule: ${matchingRule.permission}` };
  }
  // git_commit 硬编码禁 push (双保险, 即便用户规则 allow 也拒绝 message 含 'push')
  if (tool === 'git_commit' && messageArg?.toLowerCase().includes('push')) {
    return { kind: 'deny', reason: 'git_commit tool forbids push' };
  }

  if (matchingRule?.action === 'allow') return { kind: 'allow' };
  // H2: autonomous mode still asks for high-risk tools — don't allow a
  // one-click "rm -rf system drive" just because the user picked the
  // wildest mode. Only low/medium risk get auto-allowed.
  if (mode === 'autonomous' && toolDescriptor.risk !== 'high') return { kind: 'allow' };
  if (mode === 'goal' && toolDescriptor.risk !== 'high') return { kind: 'allow' };
  if (mode === 'smart' && toolDescriptor.risk === 'low') return { kind: 'allow' };

  let reason = `${toolDescriptor.displayName} (${tool})`;
  if (toolDescriptor.risk === 'high') reason += ' · 高风险';
  else if (toolDescriptor.risk === 'medium') reason += ' · 中风险';
  return { kind: 'ask', reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase W4 — window.* 操作权限 (独立于工具权限)
//
// 设计:
// - close main-kind = hardcoded deny (主驾驶舱绝对不能被 close)
// - 其他 window 操作默认 ask (第一次后 5min 内不重复问,见 caller 缓存)
// - 用户 allow 后 5min 内不重复问 (由 WindowHandler 的 allowedCache 实现)
// ─────────────────────────────────────────────────────────────────────────────

export type WindowOpKind = 'create' | 'close' | 'focus' | 'resize' | 'message' | 'preset';

export interface WindowOpContext {
  /** window kind: main / floating / detail / notify */
  kind?: 'main' | 'floating' | 'detail' | 'notify';
  /** window id (close/focus/resize 用) */
  id?: string;
  /** preset name (preset op 用) */
  preset?: string;
  /** 是否用户显式跳过确认 (requireConfirm=false) */
  bypassConfirm?: boolean;
}

export type WindowOpDecision = 'allow' | 'deny' | 'ask';

/**
 * evaluateWindowOp — 评估一个 window.* 操作是否需要询问用户。
 *
 * 规则:
 * 1. close main-kind = deny (硬编码,即便用户 allow 也拒绝)
 * 2. preset = ask (切换整套布局是用户可见的操作,需要确认)
 * 3. create main-kind = ask (主驾驶舱启动需要确认)
 * 4. close floating/notify + create floating/detail/notify = ask
 * 5. focus/resize/message = allow (纯本地操作,无副作用)
 * 6. bypassConfirm=true → allow (跳过 confirm)
 */
export function evaluateWindowOp(op: WindowOpKind, ctx: WindowOpContext = {}): WindowOpDecision {
  // 硬规则 1: close main-kind 永远 deny
  if (op === 'close' && ctx.kind === 'main') return 'deny';

  // 显式 skip → allow
  if (ctx.bypassConfirm === true) return 'allow';

  // preset 切换整套布局 = ask
  if (op === 'preset') return 'ask';

  // create main = ask
  if (op === 'create' && ctx.kind === 'main') return 'ask';

  // 其他 close/create 默认 ask
  if (op === 'close') return 'ask';
  if (op === 'create') return 'ask';

  // focus/resize/message = allow
  return 'allow';
}

/** close main-kind 的中文 reason (给 error envelope 用) */
export const DENY_CLOSE_MAIN_REASON = '主驾驶舱窗口不可关闭 (硬编码规则)';

/** 5 分钟 cache — 用户 allow 后同 op+kind 在 5min 内不再问 */
export const WINDOW_ALLOW_TTL_MS = 5 * 60 * 1000;
