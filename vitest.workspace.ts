import { defineWorkspace } from 'vitest/config';

/**
 * Root vitest.workspace — 多包聚合测试
 *
 * 为什么需要 root workspace:
 * - monorepo 有 backend (node 环境) + electron (jsdom 环境)
 * - 不配 root config, 在 root 跑 `npx vitest run` 会用 node 默认环境
 * - electron renderer 测试需要 jsdom, 否则 `document is not defined`
 *
 * 用法:
 * - `npx vitest run` (root) → 跑所有 workspace
 * - `cd backend && npx vitest run` → 只跑 backend
 * - `cd electron && npx vitest run` → 只跑 electron
 *
 * soul pytest 走 pytest, 不在这跑.
 */
export default defineWorkspace([
  './backend',
  './electron',
]);