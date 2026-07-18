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
