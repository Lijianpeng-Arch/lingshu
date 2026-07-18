/**
 * routes/chat-stream SSE handler tests (V6 后端)
 *
 * 覆盖:
 *   - POST /chat/stream 接收 body schema 校验
 *   - SSE 流式写出 (message_start → text_delta → message_finish)
 *   - 错误走 SSE error event 而不是 500
 *   - 心跳 ": ping\n\n"
 *   - tool_call envelope fan-out 到 SSE
 *   - tool_call forwarding 与订阅
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createChatStreamRoute, createChatStreamMetaRoute } from './chat-stream.js';
import {
  subscribeToolCallEvents,
  emitToolCall,
  _clearToolCallHandlersForTest,
} from '../envelopes/tool-call.js';

// ── helpers: fake raw response capturing SSE chunks ─────────────
function makeFakeReply(): {
  reply: any;
  chunks: string[];
  end: () => Promise<void>;
  close: () => void;
} {
  const chunks: string[] = [];
  let headerFlush = false;
  const raw: any = {
    write(data: string) {
      chunks.push(data);
      return true;
    },
    end() {
      // finalize
    },
    on(_event: string, _cb: () => void) {
      // noop
    },
    off(_event: string, _cb: () => void) {
      // noop
    },
    flushHeaders() {
      headerFlush = true;
    },
    closed: false,
    destroy(_err?: Error) {
      this.closed = true;
    },
  };
  const reply: any = {
    code: (_s: number) => reply,
    header: (_k: string, _v: string) => reply,
    send: () => reply,
    raw,
  };
  let closeCb: (() => void) | null = null;
  raw.on = (_event: string, cb: () => void) => {
    if (_event === 'close') closeCb = cb;
  };
  return {
    reply,
    chunks,
    end: async () => {
      // wait for stream to finish
      await new Promise((r) => setTimeout(r, 10));
    },
    close: () => {
      closeCb?.();
    },
  };
}

// ── mock fetch for streamChat → returns SSE chunks ─────────────
function makeReadableStreamFromChunks(chunks: string[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function mockOpenAiStyleStream(parts: string[]): Response {
  // OpenAI 兼容格式 (deepseek/openai/ollama)
  const body =
    parts
      .map(
        (p) =>
          `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}},"finish_reason":null}]}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n';
  return new Response(makeReadableStreamFromChunks([body]), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('routes/chat-stream — schema + handlers', () => {
  beforeEach(() => {
    _clearToolCallHandlersForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /chat/stream/providers returns list + default', async () => {
    const handler = createChatStreamMetaRoute();
    const result = await handler();
    expect(result.providers).toContain('ollama');
    expect(typeof result.default).toBe('string');
    expect(['deepseek', 'ollama', 'openai', 'anthropic']).toContain(result.default);
  });

  it('POST /chat/stream rejects invalid body', async () => {
    const handler = createChatStreamRoute();
    const reply = makeFakeReply();
    const req = { body: { message: '' } } as any;
    await handler(req, reply.reply);
    // fastify .code(400) — we record via reply.status
    // 这里断 reply.code 被 called,我们直接通过 chunks 没有 message_start 验证
    await reply.end();
    const all = reply.chunks.join('');
    expect(all).toBe(''); // 没流式输出
  });
});

describe('routes/chat-stream — SSE happy path', () => {
  beforeEach(() => {
    _clearToolCallHandlersForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes message_start, text_delta, message_finish events', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(mockOpenAiStyleStream(['hi', ' ', 'world'])));

    const handler = createChatStreamRoute();
    const reply = makeFakeReply();
    const req = {
      body: {
        message: 'hello',
        model: 'ollama', // ollama 永远 available
      },
    } as any;

    await handler(req, reply.reply);
    await reply.end();

    const all = reply.chunks.join('');
    // 拆 SSE 帧
    const frames = all.split('\n\n').filter(Boolean);
    // 至少 3 个 data 帧: message_start + text_delta + message_finish
    expect(frames.some((f) => f.includes('"type":"message_start"'))).toBe(true);
    expect(frames.some((f) => f.includes('"type":"text_delta"') && f.includes('hi'))).toBe(true);
    expect(frames.some((f) => f.includes('"type":"message_finish"'))).toBe(true);
  });

  it('writes SSE error event when fetch returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      () => Promise.resolve(new Response('unauth', { status: 401 })),
    );

    const handler = createChatStreamRoute();
    const reply = makeFakeReply();
    const req = { body: { message: 'hello', model: 'ollama' } } as any;

    await handler(req, reply.reply);
    await reply.end();

    const all = reply.chunks.join('');
    expect(all).toContain('"type":"error"');
    expect(all).toContain('访问密钥无效'); // 友好化消息
  });

  it('forwards tool_call envelopes to SSE stream', async () => {
    // 两段中间隔 50ms, 给 setTimeout(emitToolCall) 一个真实窗口
    async function* slowStream(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      const parts = ['a', 'b', 'c'];
      for (const p of parts) {
        const frame = `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}},"finish_reason":null}]}\n\n`;
        yield enc.encode(frame);
        await new Promise((r) => setTimeout(r, 30));
      }
      yield enc.encode('data: [DONE]\n\n');
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(slowStream() as any, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));

    const handler = createChatStreamRoute();
    const reply = makeFakeReply();
    const req = { body: { message: 'run', model: 'ollama' } } as any;

    const promise = handler(req, reply.reply);

    // 给 tool_call 一个 emit 窗口
    setTimeout(() => {
      emitToolCall({
        type: 'tool_call_start',
        toolCallId: 'tc-test',
        name: 'read_file',
        displayName: '读取文件',
        displayDescription: '读取文件内容',
        args: { path: '/tmp/x' },
        timestamp: Date.now(),
      });
    }, 15);

    await promise;
    await reply.end();

    const all = reply.chunks.join('');
    expect(all).toContain('"type":"tool_call"');
    expect(all).toContain('"toolCallId":"tc-test"');
  });

  it('forwards tool_call_result envelopes to SSE stream', async () => {
    async function* slowStream(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      yield enc.encode('data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n');
      await new Promise((r) => setTimeout(r, 30));
      yield enc.encode('data: [DONE]\n\n');
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(slowStream() as any, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));

    const handler = createChatStreamRoute();
    const reply = makeFakeReply();
    const req = { body: { message: 'run', model: 'ollama' } } as any;

    const promise = handler(req, reply.reply);

    setTimeout(() => {
      emitToolCall({
        type: 'tool_call_result',
        toolCallId: 'tc-r',
        result: { ok: true },
        durationMs: 10,
        status: 'success',
      });
    }, 15);

    await promise;
    await reply.end();

    const all = reply.chunks.join('');
    expect(all).toContain('"type":"tool_call"');
    expect(all).toContain('"status":"success"');
  });

  it('executes an LLM tool call and feeds the result into the next model turn', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const tool = {
      name: 'read_file',
      displayName: '读文件',
      displayDescription: '读取文件内容',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      risk: 'low' as const,
      execute: vi.fn(async (args: Record<string, unknown>) => ({ ok: true, content: `内容:${String(args.path)}` })),
    };
    const responses = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"notes.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
        'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"已读取文件"},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const body = responses.shift();
      return new Response(makeReadableStreamFromChunks([body ?? 'data: [DONE]\\n\\n']), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }));

    const handler = createChatStreamRoute({
      defaultProvider: 'ollama',
      toolRegistry: {
        list: () => [tool],
        get: (name: string) => (name === tool.name ? tool : undefined),
      } as any,
      mainLoop: {
        subscribeAwareness: () => () => undefined,
        gateToolCall: vi.fn(async () => ({ kind: 'allow' })),
      } as any,
    });
    const reply = makeFakeReply();
    await handler({ body: { message: '读 notes.md', model: 'ollama' } } as any, reply.reply);
    await reply.end();

    const all = reply.chunks.join('');
    expect(tool.execute).toHaveBeenCalledWith({ path: 'notes.md' });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.tools).toBeDefined();
    expect(requestBodies[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ ok: true, content: '内容:notes.md' }) }),
    ]));
    expect(all).toContain('"type":"tool_call"');
    expect(all).toContain('"type":"tool_call_start"');
    expect(all).toContain('"type":"tool_call_result"');
    expect(all).toContain('已读取文件');
  });
  it('forwards main-loop awareness events into the SSE chat stream', async () => {
    let publishAwareness: ((env: unknown) => void) | undefined;
    const tool = {
      name: 'run_command',
      displayName: '执行命令',
      displayDescription: '执行项目命令',
      description: 'Run a command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      risk: 'high' as const,
      execute: vi.fn(async () => ({ ok: true })),
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages?: Array<{ role?: string }> };
      if (body.messages?.some((message) => message.role === 'tool')) {
        return new Response(makeReadableStreamFromChunks([
          'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n',
        ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(makeReadableStreamFromChunks([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-perm","function":{"name":"run_command","arguments":"{\\"command\\":\\"npm test\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' + 'data: [DONE]\n\n',
      ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }));

    const handler = createChatStreamRoute({
      defaultProvider: 'ollama',
      toolRegistry: { list: () => [tool], get: () => tool } as any,
      mainLoop: {
        subscribeAwareness: (handler: (env: unknown) => void) => {
          publishAwareness = handler;
          return () => { publishAwareness = undefined; };
        },
        gateToolCall: vi.fn(async () => {
          // 模拟真实 mainLoop.gateToolCall 内部: 等异步路径排上, 再 broadcast
          await new Promise((r) => setImmediate(r));
          publishAwareness?.({
            id: 'perm-1',
            type: 'awareness.update',
            payload: { kind: 'permission.request', tool: 'run_command', reason: '需要确认' },
          });
          return { kind: 'deny', reason: 'Denied by user' };
        }),
      } as any,
    });
    const reply = makeFakeReply();
    await handler({ body: { message: '运行测试', model: 'ollama' } } as any, reply.reply);
    await reply.end();

    expect(reply.chunks.join('')).toContain('"type":"awareness"');
    expect(reply.chunks.join('')).toContain('permission.request');
  });

  it('does not forward tool_call events from other conversations', async () => {
    const tool = {
      name: 'read_file',
      displayName: '读文件',
      displayDescription: '读取文件内容',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      risk: 'low' as const,
      execute: vi.fn(async () => ({ ok: true })),
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      makeReadableStreamFromChunks(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n']),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));

    const replyA = makeFakeReply();
    const replyB = makeFakeReply();
    let promiseA: Promise<void> | undefined;
    let promiseB: Promise<void> | undefined;
    const handler = createChatStreamRoute({
      defaultProvider: 'ollama',
      toolRegistry: { list: () => [tool], get: () => tool } as any,
      mainLoop: { subscribeAwareness: () => () => undefined, gateToolCall: vi.fn(async () => ({ kind: 'allow' })) } as any,
    });
    promiseA = handler({ body: { message: 'A', model: 'ollama', conversationId: 'conv-A' } } as any, replyA.reply);
    promiseB = handler({ body: { message: 'B', model: 'ollama', conversationId: 'conv-B' } } as any, replyB.reply);

    // 等到 A 流出现 message_start 帧, 表明订阅已挂上 (handler 内 await 至少一次 microtask)
    for (let i = 0; i < 100 && !replyA.chunks.join('').includes('message_start'); i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    emitToolCall({
      type: 'tool_call_start',
      toolCallId: 'tc-A',
      conversationId: 'conv-A',
      name: 'read_file',
      displayName: '读文件',
      displayDescription: '读取文件内容',
      args: { path: 'notes.md' },
      timestamp: Date.now(),
    });
    emitToolCall({
      type: 'tool_call_start',
      toolCallId: 'tc-B',
      conversationId: 'conv-B',
      name: 'read_file',
      displayName: '读文件',
      displayDescription: '读取文件内容',
      args: { path: 'other.md' },
      timestamp: Date.now(),
    });

    await Promise.all([promiseA!, promiseB!]);
    await replyA.end();
    await replyB.end();

    expect(replyA.chunks.join('')).toContain('"toolCallId":"tc-A"');
    expect(replyA.chunks.join('')).not.toContain('"toolCallId":"tc-B"');
    expect(replyB.chunks.join('')).toContain('"toolCallId":"tc-B"');
    expect(replyB.chunks.join('')).not.toContain('"toolCallId":"tc-A"');
  });

  it('marks a returned ok:false tool result as an error event', async () => {
    const tool = {
      name: 'read_file',
      displayName: '读文件',
      displayDescription: '读取文件内容',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      risk: 'low' as const,
      execute: vi.fn(async () => ({ ok: false, error: 'file not found' })),
    };
    const responses = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-fail","function":{"name":"read_file","arguments":"{\\"path\\":\\"missing.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' + 'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"读取失败"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      makeReadableStreamFromChunks([responses.shift() ?? 'data: [DONE]\\n\\n']),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));
    const handler = createChatStreamRoute({
      defaultProvider: 'ollama',
      toolRegistry: { list: () => [tool], get: () => tool } as any,
    });
    const reply = makeFakeReply();
    await handler({ body: { message: '读缺失文件', model: 'ollama' } } as any, reply.reply);

    expect(reply.chunks.join('')).toContain('"status":"error"');
    expect(reply.chunks.join('')).toContain('file not found');
  });

  it('does not execute a tool when streamed arguments are invalid JSON', async () => {
    const tool = {
      name: 'list_files',
      displayName: '列文件',
      displayDescription: '列出目录文件',
      description: 'List files',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      risk: 'low' as const,
      execute: vi.fn(async () => ({ ok: true })),
    };
    const responses = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-bad-json","function":{"name":"list_files","arguments":"{bad"}}]},"finish_reason":"tool_calls"}]}\n\n' + 'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"参数错误"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      makeReadableStreamFromChunks([responses.shift() ?? 'data: [DONE]\\n\\n']),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));
    const handler = createChatStreamRoute({
      defaultProvider: 'ollama',
      toolRegistry: { list: () => [tool], get: () => tool } as any,
    });
    const reply = makeFakeReply();
    await handler({ body: { message: '列文件', model: 'ollama' } } as any, reply.reply);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(reply.chunks.join('')).toContain('"status":"error"');
    expect(reply.chunks.join('')).toContain('工具参数不是有效 JSON');
  });

  it('does not execute a high-risk tool without explicit approval', async () => {
    const tool = {
      name: 'run_command',
      displayName: '执行命令',
      displayDescription: '执行项目命令',
      description: 'Run a command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      risk: 'high' as const,
      execute: vi.fn(async () => ({ ok: true, stdout: 'should not run' })),
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const hasToolResult = Array.isArray(body.messages)
        && (body.messages as Array<{ role?: string }>).some((message) => message.role === 'tool');
      const response = hasToolResult
        ? 'data: {"choices":[{"delta":{"content":"已拒绝"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n'
        : 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-danger","function":{"name":"run_command","arguments":"{\\"command\\":\\"del important.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' + 'data: [DONE]\n\n';
      return new Response(makeReadableStreamFromChunks([response]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }));

    const handler = createChatStreamRoute({
      defaultProvider: 'ollama',
      toolRegistry: { list: () => [tool], get: () => tool } as any,
    });
    const reply = makeFakeReply();
    await handler({ body: { message: '删除重要文件', model: 'ollama' } } as any, reply.reply);
    await reply.end();

    expect(tool.execute).not.toHaveBeenCalled();
    expect(reply.chunks.join('')).toContain('"type":"tool_call_result"');
  });
  it('subscribers not invoked after unsubscribe + close', async () => {
    const seen: number[] = [];
    const unsub = subscribeToolCallEvents(() => seen.push(1));
    unsub();
    emitToolCall({
      type: 'tool_call_start',
      toolCallId: 'tc-noop',
      name: 'noop',
      displayName: 'noop',
      displayDescription: '',
      args: {},
      timestamp: Date.now(),
    });
    expect(seen).toHaveLength(0);
  });
});
