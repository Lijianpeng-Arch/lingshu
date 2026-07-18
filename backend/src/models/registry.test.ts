/**
 * models/registry tests (V6 多模型切换)
 *
 *   - getModel / listModels / listAvailableProviders
 *   - env-driven availability
 *   - streamChat 路由到正确 provider (mock fetch)
 *   - OpenAI-compatible SSE 解析 (deepseek/openai/ollama)
 *   - Anthropic streaming 解析 (claude)
 *   - 错误友好化路径
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getModel,
  listModels,
  listAvailableProviders,
  readModelPresets,
  streamChat,
  type ModelProvider,
} from './registry.js';

describe('models/registry — config', () => {
  it('readModelPresets has 4 entries (deepseek/openai/anthropic/ollama)', () => {
    expect(readModelPresets()).toHaveLength(4);
    const names = readModelPresets().map((m) => m.provider);
    expect(names).toEqual(['deepseek', 'openai', 'anthropic', 'ollama']);
  });

  it('getModel returns the right preset by provider', () => {
    expect(getModel('deepseek')?.provider).toBe('deepseek');
    expect(getModel('ollama')?.provider).toBe('ollama');
    // dummy provider 不存在
    expect(getModel('mystery' as ModelProvider)).toBeUndefined();
  });

  it('listModels returns a copy (not the singleton)', () => {
    const a = listModels();
    const b = listModels();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('models/registry — env availability', () => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  const KEYS = [
    'LINGSHU_DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OLLAMA_BASE_URL',
    'OLLAMA_MODEL',
  ];

  beforeEach(() => {
    for (const k of KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = SAVED_ENV[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('with no env vars set, only ollama is available', () => {
    const available = listAvailableProviders();
    expect(available).toContain('ollama');
    expect(available).not.toContain('deepseek');
    expect(available).not.toContain('openai');
    expect(available).not.toContain('anthropic');
  });

  it('LINGSHU_DEEPSEEK_API_KEY enables deepseek', () => {
    process.env['LINGSHU_DEEPSEEK_API_KEY'] = 'sk-test';
    const available = listAvailableProviders();
    expect(available).toContain('deepseek');
    expect(getModel('deepseek')?.apiKey).toBe('sk-test');
  });

  it('OPENAI_API_KEY enables openai', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai';
    expect(listAvailableProviders()).toContain('openai');
    expect(getModel('openai')?.apiKey).toBe('sk-openai');
  });

  it('ANTHROPIC_API_KEY enables anthropic', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-anthropic';
    expect(listAvailableProviders()).toContain('anthropic');
    expect(getModel('anthropic')?.apiKey).toBe('sk-anthropic');
  });

  it('OLLAMA_BASE_URL override respected', () => {
    process.env['OLLAMA_BASE_URL'] = 'http://192.168.1.10:11434/v1';
    expect(getModel('ollama')?.baseUrl).toBe('http://192.168.1.10:11434/v1');
  });
});

describe('models/registry — streamChat routing', () => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['LINGSHU_DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      SAVED_ENV[k] = process.env[k];
      process.env[k] = 'sk-test';
    }
  });
  afterEach(() => {
    for (const k of Object.keys(SAVED_ENV)) {
      const v = SAVED_ENV[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it('throws on unknown provider', async () => {
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const _ of streamChat('mystery' as any, { messages: [] })) {
        // noop
      }
    }).rejects.toThrow(/Unknown model provider/);
  });

  it('parses OpenAI-compatible SSE (deepseek, mocked fetch)', async () => {
    const fakeStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n' +
            'data: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(fakeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out: string[] = [];
    let finish: string | null | undefined;
    for await (const chunk of streamChat('deepseek', {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (chunk.delta) out.push(chunk.delta);
      if (chunk.done) finish = chunk.finishReason;
    }
    expect(out.join('')).toBe('hello world');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[0] as string)).toContain('chat/completions');
    // finish 可能在最后一个 done chunk 里
    expect(finish).toBeDefined();
  });

  it('parses claude streaming SSE (Anthropic format)', async () => {
    const claudeBody =
      'data: {"type":"message_start","message":{"id":"m1"}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi claude"}}\n\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'data: {"type":"message_delta","delta":{},"message":{"stop_reason":"end_turn"}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const fakeStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(claudeBody));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(fakeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out: string[] = [];
    for await (const chunk of streamChat('anthropic', {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (chunk.delta) out.push(chunk.delta);
    }
    expect(out.join('')).toBe('hi claude');
    expect((fetchMock.mock.calls[0]?.[0] as string)).toContain('/v1/messages');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('throws when LLM returns non-2xx (OpenAI-compatible)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"err":"bad key"}', { status: 401, statusText: 'Unauthorized' }),
      ),
    );
    await expect(async () => {
      for await (const _ of streamChat('deepseek', {
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // noop
      }
    }).rejects.toThrow(/401/);
  });
});
