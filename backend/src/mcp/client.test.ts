import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpClient, type McpClient } from './client.js';
import type { McpServerConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(__dirname, '__fixtures__', 'mock-mcp-server.cjs');

/** 构造一个指向 mock server 的配置。 */
function mockConfig(env: Record<string, string> = {}): McpServerConfig {
  return {
    name: 'mock',
    command: process.execPath, // node 本体
    args: [MOCK_SERVER],
    env,
  };
}

/** 每个测试自己 spawn，结束确保 shutdown 避免泄露子进程。 */
async function withClient(
  cfg: McpServerConfig,
  fn: (c: McpClient) => Promise<void>,
  opts?: Parameters<typeof createMcpClient>[1],
): Promise<void> {
  const client = await createMcpClient(cfg, opts);
  try {
    await fn(client);
  } finally {
    await client.shutdown();
  }
}

describe('createMcpClient', () => {
  it('spawns and completes initialize handshake', async () => {
    await withClient(mockConfig(), async (c) => {
      expect(c).toBeTruthy();
      expect(typeof c.listTools).toBe('function');
    });
  });

  it('listTools returns 1 tool', async () => {
    await withClient(mockConfig(), async (c) => {
      const tools = await c.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('echo');
    });
  });

  it('listTools parses inputSchema', async () => {
    await withClient(mockConfig(), async (c) => {
      const tools = await c.listTools();
      expect(tools[0]!.inputSchema.type).toBe('object');
      expect(tools[0]!.inputSchema.required).toEqual(['text']);
    });
  });

  it('listTools carries description', async () => {
    await withClient(mockConfig(), async (c) => {
      const tools = await c.listTools();
      expect(tools[0]!.description).toMatch(/echo/i);
    });
  });

  it('callTool echoes arguments (JSON-RPC roundtrip)', async () => {
    await withClient(mockConfig(), async (c) => {
      const res = (await c.callTool('echo', { text: 'hi' })) as { echoed: { text: string } };
      expect(res.echoed.text).toBe('hi');
    });
  });

  it('callTool with empty args works', async () => {
    await withClient(mockConfig(), async (c) => {
      const res = (await c.callTool('echo', {})) as { echoed: Record<string, unknown> };
      expect(res.echoed).toEqual({});
    });
  });

  it('respects custom tool name via env (prefix scenario)', async () => {
    await withClient(mockConfig({ MOCK_TOOL_NAME: 'create_issue' }), async (c) => {
      const tools = await c.listTools();
      expect(tools[0]!.name).toBe('create_issue');
    });
  });

  it('throws on JSON-RPC error response', async () => {
    await withClient(mockConfig(), async (c) => {
      await expect(c.callTool('boom', {})).rejects.toThrow(/boom failed/);
    });
  });

  it('error response includes the error code', async () => {
    await withClient(mockConfig(), async (c) => {
      await expect(c.callTool('boom', {})).rejects.toThrow(/-32000/);
    });
  });

  it('callTool times out when server never responds', async () => {
    await withClient(
      mockConfig(),
      async (c) => {
        await expect(c.callTool('slow', {})).rejects.toThrow(/timed out/);
      },
      { callTimeoutMs: 300 },
    );
  });

  it('handshake fails (rejects) when server never answers initialize', async () => {
    await expect(
      createMcpClient(mockConfig({ MOCK_MODE: 'noinit' }), { initTimeoutMs: 300 }),
    ).rejects.toThrow(/timed out/);
  });

  it('handshake fails when command does not exist', async () => {
    await expect(
      createMcpClient({ name: 'x', command: 'this_binary_does_not_exist_xyz', args: [] }),
    ).rejects.toThrow();
  });

  it('shutdown resolves gracefully (SIGTERM)', async () => {
    const c = await createMcpClient(mockConfig());
    await expect(c.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown is idempotent', async () => {
    const c = await createMcpClient(mockConfig());
    await c.shutdown();
    await expect(c.shutdown()).resolves.toBeUndefined();
  });

  it('calling after shutdown rejects (not running)', async () => {
    const c = await createMcpClient(mockConfig());
    await c.shutdown();
    await expect(c.callTool('echo', { text: 'x' })).rejects.toThrow();
  });

  it('two sequential calls both resolve (id matching)', async () => {
    await withClient(mockConfig(), async (c) => {
      const a = (await c.callTool('echo', { text: 'a' })) as { echoed: { text: string } };
      const b = (await c.callTool('echo', { text: 'b' })) as { echoed: { text: string } };
      expect(a.echoed.text).toBe('a');
      expect(b.echoed.text).toBe('b');
    });
  });
});
