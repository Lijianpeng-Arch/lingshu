/**
 * MCP (Model Context Protocol) 接入 — 类型定义
 *
 * 借鉴: OpenCode mcp client。
 *
 * 灵枢在启动时扫 ~/.lingshu/mcp/*.json，每个配置 spawn 一个 MCP server
 * (stdio + JSON-RPC 2.0)，握手后拉 tools/list，把每个 tool 加前缀
 * `mcp__<server>__<tool>` 注册到 ToolRegistry。
 */

/** 极简 JSON Schema 类型 (MCP tool 的 inputSchema)。递归结构，够描述参数即可。 */
export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[];
  required?: string[];
  enum?: unknown[];
  description?: string;
  // MCP server 可能返回额外字段，允许透传
  [key: string]: unknown;
}

/** 单个 MCP server 配置 (~/.lingshu/mcp/<name>.json 的内容)。 */
export interface McpServerConfig {
  /** 唯一标识 (也用于 tool 前缀 mcp__<name>__<tool>) */
  name: string;
  /** 启动命令，例如 'npx' */
  command: string;
  /** 命令参数，例如 ['-y', '@modelcontextprotocol/server-github'] */
  args: string[];
  /** 追加到子进程的环境变量 (与 process.env 合并) */
  env?: Record<string, string>;
  /** 是否启用；缺省视为 true，false 时跳过 spawn */
  enabled?: boolean;
}

/** MCP server 通过 tools/list 返回的单个 tool 描述。 */
export interface McpToolSpec {
  /** 原 server 内的 tool 名 (未加前缀) */
  name: string;
  description?: string;
  inputSchema: JSONSchema;
}

/** JSON-RPC 2.0 请求 (发给 MCP server)。 */
export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 响应 (从 MCP server 收到)。 */
export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** JSON-RPC 2.0 通知 (无 id，例如 notifications/initialized)。 */
export interface McpJsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** callTool 默认超时 (ms) — 30s。 */
export const MCP_CALL_TIMEOUT_MS = 30_000;

/** initialize 握手超时 (ms) — 10s。 */
export const MCP_INIT_TIMEOUT_MS = 10_000;

/** shutdown 时 SIGTERM 后等待多久再 SIGKILL (ms) — 5s。 */
export const MCP_SHUTDOWN_GRACE_MS = 5_000;

/** 灵枢作为 MCP client 上报的协议版本与信息。 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_CLIENT_INFO = { name: 'lingshu', version: '2.0.0' } as const;
