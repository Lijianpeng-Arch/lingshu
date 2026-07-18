/**
 * SessionRepo tests — v0.3 会话持久化
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSessionRepo } from './session-repo.js';
import { createSqlite } from './sqlite.js';

describe('db/session-repo', () => {
  let repo: ReturnType<typeof createSessionRepo>;
  let db: ReturnType<typeof createSqlite>;

  beforeEach(() => {
    db = createSqlite(':memory:');
    repo = createSessionRepo(db);
  });

  it('creates a session with provider and model', () => {
    const session = repo.ensureSession({ id: 'conv-1', title: '读文件', provider: 'ollama', model: 'llama3.1' });
    expect(session.id).toBe('conv-1');
    expect(session.provider).toBe('ollama');
    expect(session.model).toBe('llama3.1');
    expect(session.startedAt).toBeGreaterThan(0);
  });

  it('reuses an existing session without overwriting counters', () => {
    repo.ensureSession({ id: 'conv-1', provider: 'ollama' });
    repo.recordMessage({ sessionId: 'conv-1', role: 'user', content: 'hi' });
    const second = repo.ensureSession({ id: 'conv-1', provider: 'deepseek' });
    expect(second.provider).toBe('ollama');
    expect(second.messageCount).toBe(1);
  });

  it('records user/assistant/tool messages with token and tool counters', () => {
    repo.ensureSession({ id: 'conv-1' });
    repo.recordMessage({ sessionId: 'conv-1', role: 'user', content: '读 notes.md' });
    const assistant = repo.recordMessage({
      sessionId: 'conv-1',
      role: 'assistant',
      content: '好的',
      toolCallId: 'call-1',
      toolName: 'read_file',
      promptTokens: 12,
      completionTokens: 5,
    });
    repo.incrementToolCall('conv-1');
    repo.finishSession('conv-1');

    const messages = repo.getSessionMessages('conv-1');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('读 notes.md');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].toolCallId).toBe('call-1');
    expect(messages[1].toolName).toBe('read_file');
    expect(assistant.promptTokens).toBe(12);
    expect(assistant.completionTokens).toBe(5);

    const list = repo.listSessions(10);
    expect(list).toHaveLength(1);
    expect(list[0].messageCount).toBe(2);
    expect(list[0].toolCallCount).toBe(1);
    expect(list[0].promptTokens).toBe(12);
    expect(list[0].completionTokens).toBe(5);
    expect(list[0].endedAt).toBeGreaterThan(0);
  });
});
