/**
 * Lingshu Backend HTTP + WebSocket Server
 *
 * Phase 2: minimal Fastify + @fastify/websocket
 *  - CORS for Electron renderer (http://localhost:5173)
 *  - GET  /api/health        → { status: "ok" }
 *  - POST /api/providers/:name/probe → ProbeResult
 *  - WS   /ws                → UACS envelopes
 *
 * Boot is split into a `buildApp()` factory (testable via fastify.inject())
 * and a production entry guard that runs only when this file is the entry point.
 *
 * Note on types: dev runs via `tsx`, so missing @types/ws is fine here.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

// 加载 .env: 从 cwd 向上查找, 直到找到带 workspaces 的根 package.json (monorepo root)
function findProjectRoot(start: string): string {
  let cur = path.resolve(start);
  let last = cur;
  while (true) {
    const pkgPath = path.join(cur, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.workspaces) return cur; // monorepo root
        last = cur;
      } catch {
        /* ignore */
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return last;
    cur = parent;
  }
}
const PROJECT_ROOT = findProjectRoot(process.cwd());
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

import { createDispatcher, type Dispatcher, type UACSHandler } from './uacs/dispatcher.js';
import { UACSEnvelopeSchema, type UACSEnvelope } from './uacs/envelope.js';
import { classifyError } from './providers/errors.js';
import type { ProbeResult, ProviderConfig } from './providers/types.js';
import { getProvider, getProviderByName, registerProvider } from './providers/registry.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { createChatHandler } from './llm/chat-handler.js';
import { bootSkills, SkillsBootError } from './skills/boot.js';
import { createSkillRoutes } from './skills/routes.js';
import { createToolMetadataRoutes } from './tools/metadata-routes.js';
import { createSqlite } from './db/sqlite.js';
import { createMainLoop, type MainLoop } from './agent/main-loop.js';
import { getSoulBridge } from './soul-bridge.js';
import { createToolRegistry } from './tools/registry.js';
import { BUILTIN_TOOLS } from './tools/builtin.js';
import { createMcpRegistry } from './mcp/registry.js';
import { createChatStreamRoute, createChatStreamMetaRoute } from './routes/chat-stream.js';
import { listAvailableProviders } from './models/registry.js';
import { createProvidersRoute } from './routes/providers.js';
import { createSessionRepo } from './db/session-repo.js';

/**
 * Boot-time Provider registration. Phase 2: env-driven. Phase 3: DB-backed.
 * Registers DeepSeek if LINGSHU_DEEPSEEK_API_KEY is set.
 */
function bootProviders(): void {
  const deepseekKey = process.env.LINGSHU_DEEPSEEK_API_KEY;
  if (deepseekKey) {
    const cfg: ProviderConfig = {
      name: 'deepseek',
      baseURL: process.env.LINGSHU_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: deepseekKey,
      capabilities: ['chat', 'tool_use'],
      models: { chat: 'deepseek-chat' },
      timeoutMs: 600_000,
    };
    registerProvider(new DeepSeekProvider(cfg));
    console.log('[boot] DeepSeek provider registered');
  } else {
    console.log('[boot] DeepSeek provider skipped (LINGSHU_DEEPSEEK_API_KEY not set)');
  }
}

/**
 * Minimal shape of a connected ws client — matches both `ws.WebSocket` and
 * the SocketStream exposed by @fastify/websocket for the parts we touch.
 */
interface WsClient {
  readyState: number;
  OPEN: number;
  send(data: string): void;
  ping?(): void;
  on(event: 'message', cb: (raw: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export interface BuildAppOptions {
  /** Override DB path (default: $LINGSHU_DB_PATH or ~/.lingshu/data.sqlite). */
  dbPath?: string;
  /** Pass '' to skip skill boot entirely (used by tests). */
  skillsDir?: string;
  /** Skip mainLoop.start() call (for tests). */
  skipMainLoop?: boolean;
  /** Disable Fastify logger (for tests). */
  quiet?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  mainLoop: MainLoop;
  clients: Set<WsClient>;
  sessionRepo: ReturnType<typeof createSessionRepo>;
  /** Returns the host to bind to; throws if requested host is not in loopback whitelist. */
  resolveHost: (requested: string | undefined) => string;
  keepalive: NodeJS.Timeout;
}

/**
 * Build (but do not listen on) the Fastify app. Wires SQLite, MainLoop,
 * CORS, WebSocket, provider probe, skill routes, and tool metadata routes.
 *
 * Does NOT start the MainLoop by default — caller decides.
 * Does NOT call app.listen() — caller does.
 * Does NOT call process.exit() on boot errors — boot errors throw.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  bootProviders();

  // ── Module-level state ───────────────────────────────────────────
  // One dispatcher + one connected-client set, shared by all routes.
  // MainLoop is wired with a SQLite handle + broadcast hook so the agent's
  // self-driven tick cycle has somewhere to land. Phase B.5 / B.2 will replace
  // the placeholder has* predicates with real pending-message / active-task state.
  const DB_PATH = opts.dbPath ?? process.env['LINGSHU_DB_PATH'] ?? path.join(os.homedir(), '.lingshu', 'data.sqlite');
  const sqlite = createSqlite(DB_PATH);
  const sessionRepo = createSessionRepo(sqlite);
  const startedAtMs = Date.now();
  const clients = new Set<WsClient>();

  // M19: keepalive ping every 30s — prunes dead sockets and detects half-open connections.
  const keepalive = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) { clients.delete(ws); continue; }
      try { ws.ping?.(); } catch { clients.delete(ws); }
    }
  }, 30_000);
  if (typeof keepalive.unref === 'function') keepalive.unref();
  // W5: 共享 ToolRegistry (builtin + 后续 MCP 注册) + McpRegistry。
  // 两者通过 mainLoop deps 接入: start() 时 mcpRegistry.start() 拉 server,
  // 完成后 registerToolsTo(toolRegistry) 加 mcp__ 前缀的 tool。
  const toolRegistry = createToolRegistry();
  for (const t of BUILTIN_TOOLS) toolRegistry.register(t);
  const mcpRegistry = createMcpRegistry();

  const mainLoop: MainLoop = createMainLoop({
    db: sqlite,
    broadcast: (env) => {
      const json = JSON.stringify(env);
      for (const c of clients) {
        if (c.readyState === c.OPEN) {
          try { c.send(json); } catch (err) { console.error('[ws] mainloop broadcast failed:', err); }
        }
      }
    },
    hasPendingUserMessage: () => false, // Phase B.5 wires chat-handler pending state
    hasActiveTask: () => false,
    isRateLimited: () => false,
    awakeningTicks: () => Math.floor((Date.now() - startedAtMs) / 10_000),
    reminderDueMs: () => undefined,
    startedAtMs,
    mcpRegistry,
    toolRegistry,
  });

  const dispatcher: Dispatcher = createDispatcher({ agent: { mainLoop } });

  // ── WS broadcast helpers ────────────────────────────────────────
  // M18: drop messages to slow clients whose send buffer exceeds 1 MiB
  // to prevent memory blowup from a stalled renderer.
  function sendSafe(ws: WsClient, data: string): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (buffered > 1_000_000) {
      console.warn('[ws] slow client, dropping message (buffered=' + buffered + ')');
      return false;
    }
    try { ws.send(data); return true; }
    catch (err) { console.error('[ws] send failed:', err); return false; }
  }

  // Broadcast any envelope sourced from a handler back to all renderers.
  const broadcast: UACSHandler = (env) => {
    const json = JSON.stringify(env);
    for (const c of clients) sendSafe(c, json);
  };
  dispatcher.registerWildcard(broadcast);

  // ── Fastify app ──────────────────────────────────────────────────
  const app: FastifyInstance = Fastify({
    logger: opts.quiet ? false : { level: 'info' },
    // M17: bodyLimit caps HTTP body size to prevent OOM. Skill installs
    // are text-only (manifest JSON + inline content), so 1 MiB is generous.
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, {
    origin: ['http://localhost:5173'], // Vite dev origin (Electron renderer)
    credentials: true,
  });

  await app.register(websocket);

  // ── GET /api/health ──────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/sessions/:id/messages', async (req) => {
    return sessionRepo.getSessionMessages(req.params.id);
  });

  app.get('/api/sessions', async () => sessionRepo.listSessions(50));

  app.get('/api/health', async () => ({ status: 'ok' }));

  const PermissionResolveBodySchema = z.object({
    decision: z.enum(['allow', 'deny']),
  });
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/permissions/:id/resolve',
    async (req, reply) => {
      const parsed = PermissionResolveBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { ok: false, error: parsed.error.message };
      }
      const resolved = mainLoop.resolvePermission(req.params.id, parsed.data.decision);
      if (!resolved) {
        reply.code(404);
        return { ok: false, error: 'permission_not_found' };
      }
      return { ok: true };
    },
  );

  // ── POST /chat/stream (统一聊天通道, SSE 流式) ──────────────────
  // 灵枢前端唯一聊天入口。底层走 models/registry.streamChat(),
  // 已内建工具调用转发 / 用量记账 / 中断 / 心跳。ws /ws 通道并存供 agent 主循环用。
  const chatStreamHandler = createChatStreamRoute({
    mainLoop,
    toolRegistry,
    sessionRepo,
    defaultProvider: listAvailableProviders().includes('deepseek')
      ? 'deepseek'
      : listAvailableProviders()[0],
  });
  app.post('/chat/stream', chatStreamHandler);
  app.get('/chat/stream/providers', createChatStreamMetaRoute());
  app.log.info('[boot] /chat/stream SSE route + /chat/stream/providers meta route registered');

  // ── GET /api/providers (provider + 模型列表, 供前端选择器) ──────────
  createProvidersRoute()(app);
  app.log.info('[boot] /api/providers route registered');

  // ── /api/files (文件工具) ─────────────────────────────────────────
  // 4 路由: list/read/write/search + sandbox meta. 写文件要 confirmToken.
  const { filesRoutes } = await import('./routes/files.js');
  await filesRoutes(app);
  app.log.info('[boot] /api/files routes registered (sandbox + confirmToken)');

  // ── /api/commands (命令工具) ──────────────────────────────────────
  // run 命令 + 黑名单 + confirmToken + Windows timeout 检测.
  const { commandsRoutes } = await import('./routes/commands.js');
  await commandsRoutes(app);
  app.log.info('[boot] /api/commands/run route registered (blacklist + confirmToken)');

  // ── /api/memory (长期记忆) ────────────────────────────────────────
  // recall/store 简化版,SQLite LIKE 匹配. 生产版用向量数据库.
  const { memoryRoutes } = await import('./routes/memory.js');
  await memoryRoutes(app, { db: sqlite });
  app.log.info('[boot] /api/memory routes registered (SQLite LIKE recall)');

  // ── /api/settings (设置页 + CRUD) ─────────────────────────────────
  // GET 全量 + PATCH 合并 + POST test-key probe
  const { settingsRoutes } = await import('./routes/settings.js');
  await settingsRoutes(app);
  app.log.info('[boot] /api/settings routes registered (CRUD + test-key)');

  // ── POST /api/providers/:name/probe ──────────────────────────────
  // Note: probe uses the provider registered at boot (this.config.apiKey).
  // Body only carries optional baseURL/model overrides — apiKey is NOT
  // accepted here to avoid confusion (it would be ignored anyway).
  const ProbeBodySchema = z.object({
    baseURL: z.string().optional(),
    model: z.string().optional(),
  });

  app.post<{ Params: { name: string }; Body: z.infer<typeof ProbeBodySchema> }>(
    '/api/providers/:name/probe',
    async (req, reply) => {
      const name = (req as FastifyRequest<{ Params: { name: string } }>).params.name;
      const parsed = ProbeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          ok: false,
          provider: name,
          error: { kind: 'unknown', message: parsed.error.message },
        } satisfies ProbeResult;
      }
      const provider = getProviderByName(name);
      if (!provider) {
        reply.code(404);
        return {
          ok: false,
          provider: name,
          error: { kind: 'unknown', message: `Provider "${name}" not registered` },
        } satisfies ProbeResult;
      }
      try {
        const result = await provider.probe();
        return result;
      } catch (err) {
        return {
          ok: false,
          provider: name,
          error: classifyError(err, name),
        } satisfies ProbeResult;
      }
    }
  );

  // ── WS /ws ───────────────────────────────────────────────────────
  await app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket /* SocketStream */) => {
      const ws = socket as unknown as WsClient;
      // M17b: per-connection AbortController — aborted on close/error so
      // dispatch handlers can observe connection lifetime (future work).
      const connAbort = new AbortController();
      clients.add(ws);
      fastify.log.info({ count: clients.size }, '[ws] client connected');

      const emit = (env: UACSEnvelope) => {
        sendSafe(ws, JSON.stringify(env));
      };

      // Per-connection dispatcher: chat.request 回推到本连接；其他类型走全局广播。
      const connDispatcher = createDispatcher();
      connDispatcher.register('chat.request', createChatHandler({ emit, getProvider, mainLoop, tools: toolRegistry.list() }));
      connDispatcher.registerWildcard((env) => {
        if (env.type !== 'chat.delta' && env.type !== 'chat.done') broadcast(env);
      });

      let messageChain: Promise<unknown> = Promise.resolve();

      const handleMessage = async (_client: WsClient, raw: Buffer): Promise<void> => {
        if (connAbort.signal.aborted) return;
        let parsed;
        try {
          const obj = JSON.parse(raw.toString());
          parsed = UACSEnvelopeSchema.safeParse(obj);
        } catch (err) {
          fastify.log.error({ err }, '[ws] malformed JSON');
          return;
        }
        if (!parsed.success) {
          fastify.log.warn({ err: parsed.error.message }, '[ws] invalid envelope');
          return;
        }
        await connDispatcher.dispatch(parsed.data);
      };

      ws.on('message', (raw: Buffer) => {
        messageChain = messageChain
          .then(() => handleMessage(ws, raw))
          .catch((err) => fastify.log.error({ err }, '[ws] dispatch error'));
      });

      ws.on('close', () => {
        clients.delete(ws);
        connAbort.abort();
        fastify.log.info({ count: clients.size }, '[ws] client disconnected');
      });

      ws.on('error', (err: Error) => {
        clients.delete(ws);
        connAbort.abort();
        fastify.log.error({ err: err.message }, '[ws] socket error');
      });
    });
  });

  // ── Skill boot (Spec 1 C4) ──────────────────────────────────────
  // 启动时扫 ~/.lingshu/skills/,校验 manifest。失败 → 抛错 (满足 Spec §2.1 B "启动时报错")。
  // 生产入口负责 process.exit(2); buildApp() 抛错由调用方决定怎么退。
  if (opts.skillsDir !== '') {
    try {
      await bootSkills();
    } catch (err) {
      if (err instanceof SkillsBootError) {
        app.log.error({ err: err.message }, '[boot] skills load failed');
      } else {
        app.log.error({ err }, '[boot] unexpected skill-boot error');
      }
      throw err;
    }
  }

  // ── Skills HTTP (Spec 1 C2/C6) ──────────────────────────────────
  await app.register(createSkillRoutes({ getProvider }));
  app.log.info(`[boot] skills dir resolved: ${process.env.LINGSHU_SKILLS_DIR ?? '~/.lingshu/skills'}`);

  // ── Tool metadata HTTP (Spec 2B) ────────────────────────────────
  await app.register(createToolMetadataRoutes());
  app.log.info('[boot] tool metadata routes registered (GET /api/tools, /api/tools/:name)');

  // H3: hard-pin the bind host to loopback. env override is allowed only for the
  // loopback whitelist — anything else is rejected fail-fast so we never expose
  // the backend to the LAN/WAN by accident (the Electron renderer is local).
  const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
  function resolveHost(requested: string | undefined): string {
    const h = requested ?? '127.0.0.1';
    if (!ALLOWED_HOSTS.has(h)) {
      throw new Error(
        `HOST=${h} rejected — only loopback (127.0.0.1, localhost, ::1) allowed`,
      );
    }
    return h;
  }

  if (!opts.skipMainLoop) {
    mainLoop.start();
  }

  return { app, mainLoop, clients, sessionRepo, resolveHost, keepalive };
}

// ── Production entry-point ─────────────────────────────────────────────
// When this file is run directly (`tsx src/server.ts`), boot the full server.
// When imported by tests, only `buildApp` is consumed.
const isMain = import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain) {
  const built = await buildApp();
  const PORT = Number(process.env.PORT ?? 3000);

  let HOST: string;
  try {
    HOST = built.resolveHost(process.env.HOST ?? undefined);
  } catch (err) {
    console.error(`[boot] ${(err as Error).message}`);
    process.exit(1);
  }

  const stopMainLoop = async () => {
    // 关 Soul 子进程优先于 mainLoop: mainLoop 可能还在写 memory, Soul 关了就断了。
    await getSoulBridge().shutdown();
    clearInterval(built.keepalive);
    built.mainLoop.stop();
  };
  process.once('SIGINT', () => { void stopMainLoop(); });
  process.once('SIGTERM', () => { void stopMainLoop(); });

  // 启动 Soul 子进程 — 失败不抛, 走 no-soul 模式(只有本地 memory)。
  try {
    const soulOk = await getSoulBridge().start();
    if (soulOk) {
      built.app.log.info('[boot] Soul bridge ready');
    } else {
      built.app.log.warn('[boot] Soul bridge not ready — running in no-soul mode');
    }
  } catch (err) {
    built.app.log.warn({ err }, '[boot] Soul bridge start failed — running in no-soul mode');
  }

  try {
    await built.app.listen({ port: PORT, host: HOST });
    built.app.log.info(`Lingshu backend listening on http://${HOST}:${PORT}`);
  } catch (err) {
    built.app.log.error(err);
    await getSoulBridge().shutdown();
    process.exit(1);
  }
}
