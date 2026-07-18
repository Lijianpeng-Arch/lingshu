import os from 'node:os';

/**
 * OpenCode permission/wildcard.ts 灵枢化。
 * 通配语法: ~/  → home; *  → 单段; **  → 多段
 *
 * Windows 兼容: OpenCode 原版在 POSIX 上, 灵枢在 Win 也跑,
 * 所以归一化反斜杠 → 正斜杠。
 */
export function matchWildcard(pattern: string, path: string): boolean {
  const MAX_PATH_LEN = 4096;
  if (path.length > MAX_PATH_LEN) return false;
  // 展开 ~/
  const expand = (p: string) => p.startsWith('~/') ? os.homedir() + p.slice(1) : p;
  // Windows 路径归一化: 反斜杠 → 正斜杠
  const normalize = (p: string) => p.replace(/\\/g, '/');
  pattern = normalize(expand(pattern));
  path = normalize(expand(path));

  // 先用占位符替换通配符 (避免被 regex 转义破坏), 再转义其余特殊字符
  const regexStr = pattern
    .replace(/\*\*/g, '\0DBL\0')
    .replace(/\*/g, '\0SGL\0')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\0DBL\0/g, '.*')
    .replace(/\0SGL\0/g, '[^/]*');

  const regex = new RegExp('^' + regexStr + '$');
  return regex.test(path);
}