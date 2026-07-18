/**
 * MCP tool 包装 — 把一个 MCP tool spec 包成灵枢的 ToolDefinition。
 *
 * 借鉴: OpenCode mcp client + 灵枢 ToolRegistry 约定。
 *
 * 规则:
 * - 工具名加前缀 `mcp__<server>__<tool>` 防止和 builtin / 其他 server 冲突
 * - 默认 risk='medium' → 走 permission gate (smart 模式 medium 会 ask)
 * - 必填中文 displayName / displayDescription (registry.register 会校验)
 * - execute 通过 McpClient.callTool 调用真实 server
 */

import type { ToolDefinition } from '../tools/registry.js';
import type { McpClient } from './client.js';
import type { McpToolSpec } from './types.js';

/** 拼接 MCP tool 的全限定名: mcp__<server>__<tool>。 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * 把一个 MCP tool 包成 ToolDefinition。
 *
 * @param serverName MCP server 名 (前缀用)
 * @param spec       server 返回的 tool spec
 * @param client     已初始化的 McpClient (execute 时调 callTool)
 */
export function wrapMcpTool(
  serverName: string,
  spec: McpToolSpec,
  client: McpClient,
): ToolDefinition {
  const fullName = mcpToolName(serverName, spec.name);
  const desc = spec.description?.trim() || `MCP 工具 ${spec.name} (来自 ${serverName})`;
  return {
    name: fullName,
    displayName: `${serverName} · ${spec.name}`,
    displayDescription: `MCP 外部工具: ${desc}`,
    description: desc,
    // MCP 外部工具默认中风险 — 走权限门，避免外部 server 无声副作用
    risk: 'medium',
    parameters: (spec.inputSchema as Record<string, unknown>) ?? { type: 'object' },
    execute: async (args: Record<string, unknown>) => {
      return client.callTool(spec.name, args ?? {});
    },
  };
}
