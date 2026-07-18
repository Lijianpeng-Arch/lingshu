/**
 * MCP Registry — 加载 ~/.lingshu/mcp/*.json，spawn 每个 server，拉 tools，
 * 注册到灵枢 ToolRegistry。
 *
 * 借鉴: OpenCode mcp client + 灵枢 skills/boot.ts 的 "启动扫目录" 模式。
 *
 * 设计原则:
 * - 单 server 失败不影响其他 (状态记 'failed'，附 error 文本)
 * - 注册 tool 时加前缀 mcp__<server>__<tool> 防冲突
 * - 前缀名撞到 builtin protected → ToolNameProtectedError (由 registry.register 抛出)
 * - shutdown 优雅 kill 所有 server (SIGTERM → 5s → SIGKILL)
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ToolRegistry, ToolDefinition } from '../tools/registry.js';
import { ToolNameProtectedError } from '../tools/registry.js';
import { createMcpClient, type McpClient } from './client.js';
import { wrapMcpTool } from './permission.js';
import type { McpServerConfig, McpToolSpec } from './types.js';

/** 默认 ~/.lingshu/mcp，可由 LINGSHU_MCP_DIR 覆盖。 */
export function defaultMcpDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LINGSHU_MCP_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.lingshu', 'mcp');
}

export interface McpServerStatus {
  name: string;
  status: 'running' | 'failed' | 'stopped';
  toolCount: number;
  error?: string;
}

export interface McpRegistry {
  /** 加载配置 + spawn servers + 拉 tools (single-server 失败不阻塞其他) */
  start(): Promise<void>;
  /** 优雅关闭所有 server */
  shutdown(): Promise<void>;
  /** 当前每个 server 的运行状态 */
  listServers(): McpServerStatus[];
  /** 把所有已拉到的 tool 加前缀注册进给定 ToolRegistry */
  registerToolsTo(registry: ToolRegistry): void;
}

export interface McpRegistryOptions {
  /** 默认 ~/.lingshu/mcp */
  mcpDir?: string;
  /** 日志输出，默认 console.log */
  log?: (msg: string) => void;
  /** 错误输出，默认 console.error */
  logError?: (msg: string) => void;
  /**
   * 可注入的 client 工厂 (测试用)。默认 createMcpClient。
   * 允许测试用 mock server / stub client。
   */
  clientFactory?: (cfg: McpServerConfig) => Promise<McpClient>;
}

/**
 * 扫 mcpDir 下的 *.json，解析为 McpServerConfig[]。
 * - 目录不存在 → 返回 []
 * - 单个 json 解析失败 / 缺 name/command → 跳过 (记 warn，不抛)
 */
export async function loadMcpConfigs(
  mcpDir: string,
  logError: (msg: string) => void = (m) => console.error(m),
): Promise<McpServerConfig[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(mcpDir);
  } catch {
    return []; // 目录不存在 — 正常，没有配 MCP
  }
  const configs: McpServerConfig[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(mcpDir, entry);
    try {
      const raw = await fs.readFile(full, 'utf8');
      const parsed = JSON.parse(raw) as Partial<McpServerConfig>;
      if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
        logError(`[mcp] ${entry}: 缺少 name 字段，跳过`);
        continue;
      }
      if (typeof parsed.command !== 'string' || !parsed.command.trim()) {
        logError(`[mcp] ${entry}: 缺少 command 字段，跳过`);
        continue;
      }
      configs.push({
        name: parsed.name,
        command: parsed.command,
        args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
        env: parsed.env,
        enabled: parsed.enabled,
      });
    } catch (err) {
      logError(`[mcp] ${entry}: 解析失败 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return configs;
}

interface ServerRuntime {
  cfg: McpServerConfig;
  status: McpServerStatus;
  client?: McpClient;
  tools: ToolDefinition[];
}

export function createMcpRegistry(opts: McpRegistryOptions = {}): McpRegistry {
  const mcpDir = opts.mcpDir ?? defaultMcpDir();
  const log = opts.log ?? ((m) => console.log(m));
  const logError = opts.logError ?? ((m) => console.error(m));
  const clientFactory = opts.clientFactory ?? createMcpClient;

  const servers = new Map<string, ServerRuntime>();

  return {
    async start() {
      const configs = await loadMcpConfigs(mcpDir, logError);
      if (configs.length === 0) {
        log(`[mcp] 未发现 MCP 配置 (${mcpDir})`);
        return;
      }
      // 并行启动，单个失败不影响其他
      await Promise.all(
        configs.map(async (cfg) => {
          const rt: ServerRuntime = {
            cfg,
            status: { name: cfg.name, status: 'stopped', toolCount: 0 },
            tools: [],
          };
          servers.set(cfg.name, rt);

          if (cfg.enabled === false) {
            rt.status.status = 'stopped';
            log(`[mcp] ${cfg.name}: enabled=false，跳过`);
            return;
          }
          try {
            const client = await clientFactory(cfg);
            rt.client = client;
            const specs: McpToolSpec[] = await client.listTools();
            rt.tools = specs.map((spec) => wrapMcpTool(cfg.name, spec, client));
            rt.status.status = 'running';
            rt.status.toolCount = rt.tools.length;
            log(`[mcp] ${cfg.name}: 已启动，${rt.tools.length} 个工具`);
          } catch (err) {
            rt.status.status = 'failed';
            rt.status.error = err instanceof Error ? err.message : String(err);
            logError(`[mcp] ${cfg.name}: 启动失败 — ${rt.status.error}`);
            // 失败的 client 若已 spawn，尝试关闭
            if (rt.client) {
              try { await rt.client.shutdown(); } catch { /* ignore */ }
              rt.client = undefined;
            }
          }
        }),
      );
    },

    async shutdown() {
      await Promise.all(
        [...servers.values()].map(async (rt) => {
          if (rt.client) {
            try { await rt.client.shutdown(); } catch { /* ignore */ }
          }
          rt.status.status = 'stopped';
        }),
      );
    },

    listServers() {
      return [...servers.values()].map((rt) => ({ ...rt.status }));
    },

    registerToolsTo(registry: ToolRegistry) {
      for (const rt of servers.values()) {
        if (rt.status.status !== 'running') continue;
        // MCP tool 名称(mcp__<server>__<tool>)撞 builtin protected → 抛 ToolNameProtectedError。
        // 检查放在 MCP 这一层,因为 builtin 注册需要同名通过。
        for (const tool of rt.tools) {
          if (registry.protectedNames.has(tool.name)) {
            throw new ToolNameProtectedError(tool.name);
          }
        }
        registry.registerMany(rt.tools);
      }
    },
  };
}
