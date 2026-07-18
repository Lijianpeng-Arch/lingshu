/**
 * MVP /api/commands — 命令工具路由 (Phase 3)
 *
 * 单端点:
 * - POST /api/commands/run
 *   { command: string, confirmToken?: string, timeoutMs?: number }
 *
 * 安全:
 * - 黑名单 (rm -rf / format / diskpart / del /f /q 等) 直接拒绝
 * - 非黑名单命令要 confirmToken === "approved" (前端弹窗确认)
 * - Windows timeout 检测 (进程不响应自动 kill)
 */

import type { FastifyInstance } from 'fastify';
import { spawn, exec, type ChildProcess } from 'node:child_process';

// 黑名单: 模式 → 描述
const BLACKLIST: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf?\s+\//, reason: 'rm -rf 根目录' },
  { pattern: /\bformat\s+[a-zA-Z]:/i, reason: 'format 驱动器' },
  { pattern: /\bdiskpart\b/i, reason: 'diskpart' },
  { pattern: /\bdel\s+\/[sq]\b/i, reason: 'del 静默删除' },
  { pattern: /\brmdir\s+\/s\b/i, reason: 'rmdir 递归' },
  { pattern: /\bdd\s+if=/i, reason: 'dd 镜像写入' },
  { pattern: /\bmkfs\b/i, reason: 'mkfs 格式化' },
  { pattern: /:\(\)\s*\{.*\}/, reason: 'fork bomb' },
  { pattern: /\breg\s+delete\b/i, reason: 'reg delete 改注册表' },
  { pattern: /\bbcdedit\b/i, reason: 'bcdedit 改启动配置' },
  { pattern: /\bcipher\s+\/w\b/i, reason: 'cipher /w 擦盘' },
  { pattern: /\bnet\s+user\b/i, reason: 'net user 改账户' },
];

interface CommandRequest {
  command?: string;
  confirmToken?: string;
  timeoutMs?: number;
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

/** 单 stream (stdout/stderr) 累计上限: 超过立即 kill 进程, 防止内存无限增长 */
const MAX_OUTPUT = 50_000;
/** 响应中 stdout/stderr 截断长度: 给前端看够用, 不爆网络 */
const MAX_RETURN = 5_000;

/**
 * 跨平台杀进程 (idempotent — 重入安全):
 * - Windows: SIGKILL 被 libuv 忽略, 用 taskkill /F /T 强制杀进程树
 * - 其他: 直接 proc.kill('SIGKILL')
 * - proc 已被杀 (killed=true) 跳过; 避免 stdout 超限 + stderr 超限 + timer 同时触发造成多次 taskkill
 */
export function killProc(proc: ChildProcess, killed?: boolean): void {
  if (killed) return;
  if (isWindows() && proc.pid) {
    exec(`taskkill /pid ${proc.pid} /F /T`, (err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error(`[commands] taskkill failed for pid ${proc.pid}:`, err.message);
      }
    });
  } else {
    proc.kill('SIGKILL');
  }
}

export async function commandsRoutes(app: FastifyInstance) {
  app.post('/api/commands/run', async (req, reply) => {
    const body = (req.body ?? {}) as CommandRequest;
    const command = (body.command ?? '').trim();
    if (!command) {
      reply.code(400);
      return { error: 'command 不能为空' };
    }

    // 黑名单检查
    for (const { pattern, reason } of BLACKLIST) {
      if (pattern.test(command)) {
        reply.code(403);
        return { error: `命令被黑名单拒绝: ${reason}` };
      }
    }

    // 非白名单命令要 confirmToken
    if (body.confirmToken !== 'approved') {
      reply.code(403);
      return { error: '执行命令需要用户确认 (confirmToken="approved")' };
    }

    const timeoutMs = Math.min(body.timeoutMs ?? 10_000, 30_000);

    try {
      return await new Promise((resolve, reject) => {
        const shell = isWindows() ? 'cmd.exe' : '/bin/sh';
        const args = isWindows() ? ['/c', command] : ['-c', command];

        let proc: ChildProcess;
        try {
          // spawn() 同步抛错场景: PATH 缺失 / EACCES / ENOENT
          // 不包 try/catch → 走 reject → route handler 转 503
          proc = spawn(shell, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (e) {
          reject(e);
          return;
        }

        let stdout = '';
        let stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
          killed = true;
          killProc(proc, killed);
        }, timeoutMs);

        proc.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf-8');
          if (stdout.length > MAX_OUTPUT && !killed) {
            killed = true;
            killProc(proc, killed);
          }
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
          if (stderr.length > MAX_OUTPUT && !killed) {
            killed = true;
            killProc(proc, killed);
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({
            ok: false,
            code: -1,
            stdout: stdout.slice(0, MAX_RETURN),
            stderr: stderr.slice(0, MAX_RETURN),
            error: err.message,
          });
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve({
            ok: !killed && code === 0,
            code: code ?? -1,
            stdout: stdout.slice(0, MAX_RETURN),
            stderr: stderr.slice(0, MAX_RETURN),
            killed,
            timeoutMs,
          });
        });
      });
    } catch (e) {
      // spawn 同步抛 (PATH 缺失 / EACCES / ENOENT) → 503 而非 500
      reply.code(503);
      return {
        ok: false,
        error: 'spawn failed',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  });
}