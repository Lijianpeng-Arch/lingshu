/**
 * Session Repo — v0.3 会话持久化
 *
 * 存储 conversationId、token 计数、每轮 user/assistant 消息.
 * chat-stream 完成后调用 finishMessage() 持久化本轮结果, 启动时调用
 * ensureSession() 记录会话元数据. SQLite 迁移版本 6.
 */
import type { Database as Db } from 'better-sqlite3';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface SessionRow {
  id: string;
  title: string | null;
  startedAt: number;
  endedAt: number | null;
  provider: string | null;
  model: string | null;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  toolCallCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMessageRow {
  id: number;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolCallId: string | null;
  toolName: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: number;
}

export interface SessionRepo {
  ensureSession(opts: {
    id: string;
    title?: string;
    provider?: string;
    model?: string;
  }): SessionRow;
  finishSession(id: string): void;
  listSessions(limit?: number): SessionRow[];
  getSessionMessages(sessionId: string): SessionMessageRow[];
  recordMessage(opts: {
    sessionId: string;
    role: MessageRole;
    content: string;
    toolCallId?: string;
    toolName?: string;
    promptTokens?: number;
    completionTokens?: number;
  }): SessionMessageRow;
  incrementToolCall(sessionId: string): void;
}

interface SessionTableRow {
  id: string;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  provider: string | null;
  model: string | null;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  tool_call_count: number;
  created_at: number;
  updated_at: number;
}

function rowToSession(row: SessionTableRow): SessionRow {
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at ?? row.created_at,
    endedAt: row.ended_at,
    provider: row.provider,
    model: row.model,
    messageCount: row.message_count,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    toolCallCount: row.tool_call_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface MessageTableRow {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: number;
}

function rowToMessage(row: MessageTableRow): SessionMessageRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    createdAt: row.created_at,
  };
}

export function createSessionRepo(db: Db): SessionRepo {
  const ensure = db.prepare(`
    INSERT INTO sessions (id, title, started_at, provider, model, created_at, updated_at)
    VALUES (@id, @title, @started_at, @provider, @model, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      provider = COALESCE(sessions.provider, excluded.provider),
      model = COALESCE(sessions.model, excluded.model),
      title = COALESCE(sessions.title, excluded.title),
      started_at = COALESCE(sessions.started_at, excluded.started_at),
      updated_at = excluded.updated_at
  `);
  const finish = db.prepare(`UPDATE sessions SET ended_at = @ended_at, updated_at = @ended_at WHERE id = @id`);
  const list = db.prepare(`SELECT * FROM sessions ORDER BY COALESCE(updated_at, started_at, created_at) DESC LIMIT @limit`);
  const get = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  const listMessages = db.prepare(`SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`);
  const insertMessage = db.prepare(`
    INSERT INTO session_messages (
      session_id, role, content, tool_call_id, tool_name, prompt_tokens, completion_tokens, created_at
    ) VALUES (
      @session_id, @role, @content, @tool_call_id, @tool_name, @prompt_tokens, @completion_tokens, @now
    )
  `);
  const bumpMessage = db.prepare(`
    UPDATE sessions
    SET message_count = message_count + 1,
        prompt_tokens = prompt_tokens + @prompt,
        completion_tokens = completion_tokens + @completion,
        updated_at = @now
    WHERE id = @id
  `);
  const bumpTool = db.prepare(`
    UPDATE sessions SET tool_call_count = tool_call_count + 1, updated_at = @now WHERE id = @id
  `);

  return {
    ensureSession(opts) {
      const now = Date.now();
      ensure.run({
        id: opts.id,
        title: opts.title ?? null,
        started_at: now,
        provider: opts.provider ?? null,
        model: opts.model ?? null,
        now,
      });
      const row = get.get(opts.id) as SessionTableRow;
      return rowToSession(row);
    },
    finishSession(id) {
      const now = Date.now();
      finish.run({ id, ended_at: now });
    },
    listSessions(limit = 50) {
      const rows = list.all({ limit }) as SessionTableRow[];
      return rows.map(rowToSession);
    },
    getSessionMessages(sessionId) {
      const rows = listMessages.all(sessionId) as MessageTableRow[];
      return rows.map(rowToMessage);
    },
    recordMessage(opts) {
      const now = Date.now();
      const info = insertMessage.run({
        session_id: opts.sessionId,
        role: opts.role,
        content: opts.content,
        tool_call_id: opts.toolCallId ?? null,
        tool_name: opts.toolName ?? null,
        prompt_tokens: opts.promptTokens ?? null,
        completion_tokens: opts.completionTokens ?? null,
        now,
      });
      bumpMessage.run({
        id: opts.sessionId,
        prompt: opts.promptTokens ?? 0,
        completion: opts.completionTokens ?? 0,
        now,
      });
      const row = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(info.lastInsertRowid as number) as MessageTableRow;
      return rowToMessage(row);
    },
    incrementToolCall(sessionId) {
      bumpTool.run({ id: sessionId, now: Date.now() });
    },
  };
}
