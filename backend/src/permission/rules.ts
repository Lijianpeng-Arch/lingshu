import type { Rule } from './types';
import { matchWildcard } from './wildcard';

/**
 * OpenCode permission/evaluate.ts 灵枢化。
 * 遍历规则, 返回第一个匹配的。调用方决定 deny > allow > ask 优先级。
 */
export function findMatchingRule(
  rules: Rule[],
  permission: string,
  path?: string
): Rule | undefined {
  for (const rule of rules) {
    // permission 前缀必须匹配 (如 Read vs Read(~/Documents/**))
    if (!rule.permission.startsWith(permission)) continue;

    // pattern 必须能匹配上 (如果有 path)
    if (path !== undefined) {
      if (matchWildcard(rule.pattern, path)) return rule;
    } else {
      // 无 path 时, 通配 pattern 也算匹配
      if (matchWildcard(rule.pattern, '*')) return rule;
    }
  }
  return undefined;
}