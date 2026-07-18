/**
 * 工具集: ID / hash 复用层
 *
 * newId(prefix) — crypto.randomUUID() 包装,统一 ID 生成。
 *   用于 envelope / ACUI card / 消息 id 等。SQLite 主键、配置 id 等稳定的不要用。
 *
 * hashCode(s) — 32 位 djb2-ish 字符串 hash,MVP 用作 memory 去重 key。
 *   不要用于安全用途 (碰撞率允许), 仅用于 "相同 fact 重复存储 → 同 key INSERT OR REPLACE"。
 */
import { randomUUID } from 'node:crypto';

export function newId(prefix?: string): string {
  return prefix ? `${prefix}-${randomUUID()}` : randomUUID();
}

export function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
