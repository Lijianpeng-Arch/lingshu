/**
 * MCP Client — spawn 一个 MCP server 子进程，用 JSON-RPC 2.0 over stdio 通信。
 *
 * 借鉴: OpenCode mcp client。
 *
 * 协议流程:
 *   1. spawn(command, args, { stdio: ['pipe','pipe','pipe'], env })
 *   2. initialize 握手 (发 clientInfo/capabilities，收 serverInfo)
 *   3. 发 notifications/initialized 通知
 *   4. tools/list 拉 tool 列表
 *   5. tools/call 调用 tool (每次 30s timeout，AbortController)
 *   6. shutdown 优雅 kill (SIGTERM，5s 后 SIGKILL)
 *
 * stdout 按行 (\n) 分帧解析 JSON-RPC message；未匹配 id 的响应静默丢弃。
 * 子进程 error/exit 会 reject 所有 pending 请求。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  type McpServerConfig,
  type McpToolSpec,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpJsonRpcNotification,
  MCP_CALL_TIMEOUT_MS,
  MCP_INIT_TIMEOUT_MS,
  MCP_SHUTDOWN_GRACE_MS,
  MCP_PROTOCOL_VERSION,
  MCP_CLIENT_INFO,
} from './types.js';

export interface McpClient {
  /** 拉 tool 列表 (tools/list) */
  listTools(): Promise<McpToolSpec[]>;
  /** 调用一个 tool (tools/call)，30s timeout */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** 优雅关闭子进程 (SIGTERM → 5s → SIGKILL) */
  shutdown(): Promise<void>;
}

/** createMcpClient 的可选覆盖 (主要给测试用，缩短超时)。 */
export interface McpClientOptions {
  /** tools/call 超时 (ms)，默认 MCP_CALL_TIMEOUT_MS (30s) */
  callTimeoutMs?: number;
  /** initialize 握手超时 (ms)，默认 MCP_INIT_TIMEOUT_MS (10s) */
  initTimeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * 创建并初始化一个 MCP client。spawn 子进程 + 完成 initialize 握手。
 * 握手失败 (进程 spawn 出错 / 超时 / server 返回 error) 会 reject 并清理进程。
 */
export function createMcpClient(cfg: McpServerConfig, opts: McpClientOptions = {}): Promise<McpClient> {
  const callTimeoutMs = opts.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const initTimeoutMs = opts.initTimeoutMs ?? MCP_INIT_TIMEOUT_MS;
  return new Promise<McpClient>((resolveClient, rejectClient) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(cfg.command, cfg.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(cfg.env ?? {}) },
      });
    } catch (err) {
      rejectClient(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let nextId = 1;
    const pending = new Map<number | string, PendingCall>();
    let stdoutBuf = '';
    let closed = false;
    let settledInit = false;

    function fail(err: Error): void {
      // reject 所有 pending，包括握手 promise (若尚未 settle)
      for (const [, p] of pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
      if (!settledInit) {
        settledInit = true;
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        rejectClient(err);
      }
    }

    proc.on('error', (err) => {
      closed = true;
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    proc.on('exit', (code, signal) => {
      if (closed) return;
      closed = true;
      const msg = `MCP server "${cfg.name}" exited (code=${code}, signal=${signal})`;
      fail(new Error(msg));
    });

    // stdout 按行分帧
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        handleLine(line);
      }
    });

    // stderr 仅诊断，不影响协议
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => { /* 静默；MCP server 常把日志写 stderr */ });

    function handleLine(line: string): void {
      let msg: McpJsonRpcResponse;
      try {
        msg = JSON.parse(line) as McpJsonRpcResponse;
      } catch {
        return; // 非 JSON 行 (server 日志) — 忽略
      }
      if (msg.id === undefined || msg.id === null) return; // 通知，无需匹配
      const p = pending.get(msg.id);
      if (!p) return; // 未知 id — 丢弃
      pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }

    function send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
      if (closed) return Promise.reject(new Error(`MCP server "${cfg.name}" is not running`));
      const id = nextId++;
      const req: McpJsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`MCP call "${method}" timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref();
        }
        pending.set(id, { resolve, reject, timer });
        try {
          proc.stdin.write(JSON.stringify(req) + '\n');
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }

    function notify(method: string, params?: unknown): void {
      if (closed) return;
      const n: McpJsonRpcNotification = { jsonrpc: '2.0', method, params };
      try { proc.stdin.write(JSON.stringify(n) + '\n'); } catch { /* ignore */ }
    }

    const client: McpClient = {
      async listTools() {
        const result = await send('tools/list', {}, MCP_CALL_TIMEOUT_MS);
        const tools = (result as { tools?: unknown })?.tools;
        if (!Array.isArray(tools)) return [];
        return tools
          .filter((t): t is McpToolSpec => typeof t === 'object' && t !== null && typeof (t as McpToolSpec).name === 'string')
          .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: 'object' },
          }));
      },
      async callTool(name, args) {
        return send('tools/call', { name, arguments: args }, callTimeoutMs);
      },
      async shutdown() {
        if (closed) return;
        closed = true;
        // reject 尚在飞行的请求
        for (const [, p] of pending) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new Error(`MCP server "${cfg.name}" shutting down`));
        }
        pending.clear();
        return gracefulKill(proc);
      },
    };

    // ── initialize 握手 ──
    send(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
      initTimeoutMs,
    )
      .then(() => {
        if (settledInit || closed) return;
        settledInit = true;
        notify('notifications/initialized');
        resolveClient(client);
      })
      .catch((err) => {
        if (settledInit) return;
        settledInit = true;
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        rejectClient(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** 优雅 kill: SIGTERM，MCP_SHUTDOWN_GRACE_MS 内没退就 SIGKILL。 */
function gracefulKill(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      // 给 SIGKILL 一点时间触发 exit；即便没触发也 resolve 防止挂起
      setTimeout(finish, 200).unref?.();
    }, MCP_SHUTDOWN_GRACE_MS);
    if (typeof (killTimer as { unref?: () => void }).unref === 'function') {
      (killTimer as { unref: () => void }).unref();
    }
  });
}
