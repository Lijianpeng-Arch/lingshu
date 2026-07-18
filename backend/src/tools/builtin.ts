/**
 * Built-in tools — 4 Phase 1 tools (sandboxed + dangerous-command blocked)
 *
 * Borrowed from BaiLongma `capabilities/tools/` whitelist pattern.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from './registry.js';
import { writeFileTool } from './builtin/filesystem/write_file.js';
import { editFileTool } from './builtin/filesystem/edit_file.js';
import { deleteFileTool } from './builtin/filesystem/delete_file.js';
import { mkdirTool } from './builtin/filesystem/mkdir.js';
import { mvTool } from './builtin/search/mv.js';
import { cpTool } from './builtin/search/cp.js';
import { rmTool } from './builtin/search/rm.js';
import { globTool } from './builtin/search/glob.js';
import { grepTool } from './builtin/search/grep.js';
import { gitStatusTool, gitDiffTool, gitCommitTool } from './builtin/git/git_status.js';

const execFileAsync = promisify(execFile);
import { getSandboxRoot, isInsideSandbox as sharedIsInsideSandbox, sandboxViolationError } from './sandbox.js';
import { TOOL_LIMITS, TIMEOUTS } from '../config/constants.js';

const SANDBOX_ROOT = getSandboxRoot();

const RESULT_TEMP_DIR = path.join(os.homedir(), '.lingshu', 'tool-outputs');
const HEAD_BYTES = TOOL_LIMITS.HEAD_BYTES;
const TAIL_BYTES = TOOL_LIMITS.TAIL_BYTES;
const READ_DEFAULT_LIMIT = TOOL_LIMITS.READ_DEFAULT_LIMIT;
const READ_MAX_BYTES = TOOL_LIMITS.READ_MAX_BYTES;
const DEFAULT_TIMEOUT_MS = TIMEOUTS.DEFAULT_RUN_COMMAND_MS;
const LONG_RUNNING_THRESHOLD_MS = TIMEOUTS.LONG_RUNNING_THRESHOLD_MS;

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)\s+\//i,
  /format\s+[a-z]:/i,
  /del\s+\/s/i,
  /\bdd\s+if=/i,
  // === Spec 2A I1 — dangerous command blacklist extensions ===
  // Borrowed from OpenCode tool/bash.ts hardcoded deny list.
  /^\s*(mkfs|shutdown|reboot|poweroff|halt|init\s+0|init\s+6)\b/i,
  /\bdiskpart\b/i,
  /:\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,  // fork bomb: :(){ :|:& };:
  /\|\s*sh\b/i,                              // curl | sh / wget | sh (remote code exec)
  /(?:wget|curl)\b[^\r\n|]*\s+-O-?\s+[^\r\n|]*\|\|\s*(?:sh|bash)\b/i, // remote download then execute
];

function isInsideSandbox(target: string): boolean {
  // Delegate to shared sandbox module so test overrides take effect.
  return sharedIsInsideSandbox(target);
}

/**
 * Persist large output to a tmp file and return head+tail truncation.
 * Returns { text, tmpPath? } — tmpPath set only when persisted.
 */
async function maybePersistAndTruncate(text: string): Promise<{ text: string; tmpPath?: string }> {
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  if (totalBytes <= HEAD_BYTES + TAIL_BYTES) return { text };
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  await fs.mkdir(RESULT_TEMP_DIR, { recursive: true });
  const tmpPath = path.join(RESULT_TEMP_DIR, `${hash}.txt`);
  await fs.writeFile(tmpPath, text, 'utf-8');
  const head = text.slice(0, HEAD_BYTES);
  const tail = text.slice(text.length - TAIL_BYTES);
  const omitted = totalBytes - HEAD_BYTES - TAIL_BYTES;
  const note = `<NOTE>Output truncated: showing head ${HEAD_BYTES} + tail ${TAIL_BYTES} bytes of ${totalBytes} total. Full output at ${tmpPath}</NOTE>`;
  return {
    text: `${head}\n... [truncated ${omitted} bytes] ...\n${tail}\n${note}`,
    tmpPath,
  };
}

export async function runListFiles(args: Record<string, unknown>) {
  const target = String(args.path ?? '.');
  if (!isInsideSandbox(target)) return sandboxViolationError(target);
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return { ok: true, files: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
  } catch (err) { return { ok: false, error: String(err) }; }
}

export async function runReadFile(args: Record<string, unknown>) {
  const target = String(args.path ?? '');
  if (!target || !isInsideSandbox(target)) return sandboxViolationError(target);

  const offset = Number(args.offset ?? 0);
  const limit = args.limit === undefined ? READ_DEFAULT_LIMIT : Number(args.limit);
  if (!Number.isFinite(offset) || !Number.isFinite(limit) || offset < 0 || limit < 0) {
    return { ok: false, error: 'invalid offset/limit' };
  }

  try {
    const stat = await fs.stat(target);
    const total = stat.size;
    const start = offset;
    const end = limit === 0 ? total : Math.min(start + limit, total);

    if (end <= start) {
      // offset past EOF → return empty content (no warning unless file also oversized)
      const warning = total > READ_MAX_BYTES ? `File exceeds 5MB (${total} bytes); provide offset/limit` : undefined;
      return warning ? { ok: true, content: '', warning } : { ok: true, content: '' };
    }

    const fh = await fs.open(target, 'r');
    let content: string;
    try {
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);
      content = buf.toString('utf-8');
    } finally {
      await fh.close();
    }

    const warning = total > READ_MAX_BYTES ? `File exceeds 5MB (${total} bytes); provide offset/limit` : undefined;
    return warning ? { ok: true, content, warning } : { ok: true, content };
  } catch (err) { return { ok: false, error: String(err) }; }
}

export async function runRunCommand(args: Record<string, unknown>) {
  const command = String(args.command ?? '');
  if (!command) return { ok: false, error: 'Empty command' };
  if (DANGEROUS_PATTERNS.some(p => p.test(command))) {
    return { ok: false, error: `Command blocked by safety filter: "${command}"` };
  }

  const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const isLongRunning = timeoutMs >= LONG_RUNNING_THRESHOLD_MS;

  try {
    const { stdout, stderr } = await execFileAsync('cmd.exe', ['/c', command], {
      cwd: SANDBOX_ROOT, timeout: timeoutMs, windowsHide: true,
    });
    const truncatedStdout = await maybePersistAndTruncate(stdout);
    const truncatedStderr = await maybePersistAndTruncate(stderr);
    const tmpPath = truncatedStdout.tmpPath ?? truncatedStderr.tmpPath;

    if (isLongRunning) {
      console.warn('[tool:run_command] long-running mode; UI should show countdown');
      return {
        ok: true,
        status: 'long-running',
        stdout: truncatedStdout.text,
        stderr: truncatedStderr.text,
        ...(tmpPath ? { tmpPath } : {}),
      };
    }

    return {
      ok: true,
      stdout: truncatedStdout.text,
      stderr: truncatedStderr.text,
      ...(tmpPath ? { tmpPath } : {}),
    };
  } catch (err) {
    const e = err as { code?: string; killed?: boolean; signal?: string; message?: string };
    const isTimeout = e?.killed === true && (e?.signal === 'SIGTERM' || e?.signal === 'SIGKILL');
    if (isTimeout) {
      return { ok: false, error: `Command timed out after ${timeoutMs}ms. Use a longer timeoutMs if needed.` };
    }
    return { ok: false, error: String(err) };
  }
}

export async function runWebSearch(args: Record<string, unknown>) {
  const query = String(args.query ?? '');
  if (!query) return { ok: false, error: 'Empty query' };
  return {
    ok: true, query,
    results: [{ title: `[stub] Search result for "${query}"`, url: 'about:blank', snippet: 'Phase 1 stub. Real web search arrives in Phase 2.' }],
  };
}

export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  displayName: '列文件',
  displayDescription: '列出目录下的文件和文件夹',
  description: 'List files in a directory (sandboxed to project root).',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  risk: 'low', execute: runListFiles,
};
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  displayName: '读文件',
  displayDescription: '读文本文件,支持 offset+limit,最大 5MB',
  description: 'Read a text file (sandboxed, offset+limit supported, default 100KB per call, max 5MB).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['path'],
  },
  risk: 'low', execute: runReadFile,
};
export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  displayName: '执行命令',
  displayDescription: '在沙箱里执行 shell 命令(危险命令被拦截)',
  description: 'Run a shell command (sandboxed, dangerous commands blocked).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 60000, use >= 300000 for long-running tasks)' },
    },
    required: ['command'],
  },
  risk: 'high', execute: runRunCommand,
};
export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  displayName: '联网搜索',
  displayDescription: '搜索网络内容(Phase 1 stub)',
  description: 'Search the web (Phase 1 stub).',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  risk: 'low', execute: runWebSearch,
};

export const BUILTIN_TOOLS: ToolDefinition[] = [
  listFilesTool,
  readFileTool,
  runCommandTool,
  webSearchTool,
  // ---- Task 4: 12 new tools (filesystem + search + git) ----
  writeFileTool,
  editFileTool,
  deleteFileTool,
  mkdirTool,
  mvTool,
  cpTool,
  rmTool,
  globTool,
  grepTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
];
export const BUILTIN_NAMES: string[] = BUILTIN_TOOLS.map(t => t.name);
