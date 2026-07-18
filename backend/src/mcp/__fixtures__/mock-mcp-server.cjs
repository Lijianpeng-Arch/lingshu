#!/usr/bin/env node
/**
 * Mock MCP server — 测试用。用 JSON-RPC 2.0 over stdio 实现最小 MCP server。
 *
 * 支持:
 *   - initialize          → 返回 serverInfo + capabilities
 *   - notifications/*      → 静默忽略
 *   - tools/list           → 返回 1 个 echo tool
 *   - tools/call (echo)     → 回显 arguments
 *   - tools/call (slow)     → 挂起不响应 (测 timeout)
 *   - tools/call (boom)     → 返回 JSON-RPC error
 *
 * 行为由环境变量控制:
 *   MOCK_MODE=noinit  → initialize 不响应 (测握手超时)
 *   MOCK_MODE=crash   → 收到第一条消息后立即 exit(1)
 *   MOCK_TOOL_NAME    → 覆盖 echo tool 的名字 (测前缀 / 冲突)
 */

'use strict';

const mode = process.env.MOCK_MODE || 'normal';
const toolName = process.env.MOCK_TOOL_NAME || 'echo';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(line) {
  if (mode === 'crash') {
    process.exit(1);
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // 通知 (无 id) — 忽略
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === 'initialize') {
    if (mode === 'noinit') return; // 故意不响应
    reply({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.0.1' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    reply({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: toolName,
            description: 'Echo back the given text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    const params = msg.params || {};
    const name = params.name;
    const args = params.arguments || {};
    if (name === 'slow') {
      // 故意不响应 — 测 callTool timeout
      return;
    }
    if (name === 'boom') {
      reply({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'boom failed' },
      });
      return;
    }
    // echo (or renamed tool)
    reply({
      jsonrpc: '2.0',
      id: msg.id,
      result: { echoed: args },
    });
    return;
  }

  // 未知方法 → method not found
  reply({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'Method not found: ' + msg.method },
  });
}

// SIGTERM 时优雅退出 (测 shutdown)
process.on('SIGTERM', () => process.exit(0));
