import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekProvider } from './deepseek.js';
import type { ProviderConfig } from './types.js';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(_opts: any) {}
  },
}));

const baseConfig: ProviderConfig = {
  name: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  capabilities: ['chat', 'embedding', 'tool_use'],
  timeoutMs: 600_000,
};

describe('DeepSeekProvider', () => {
  let provider: DeepSeekProvider;

  beforeEach(() => {
    provider = new DeepSeekProvider(baseConfig);
    vi.clearAllMocks();
  });

  it('has correct name and capabilities', () => {
    expect(provider.name).toBe('deepseek');
    expect(provider.capabilities).toEqual(['chat', 'tool_use']);
  });

  it('canDo returns true for supported capability', () => {
    expect(provider.canDo('chat')).toBe(true);
    expect(provider.canDo('tool_use')).toBe(true);
  });

  it('canDo returns false for unsupported capability', () => {
    expect(provider.canDo('image')).toBe(false);
    expect(provider.canDo('tts')).toBe(false);
  });

  it('probe returns ok with latency when API succeeds', async () => {
    mockCreate.mockResolvedValue({
      id: 'test',
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    });

    const result = await provider.probe();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('deepseek');
      expect(result.model).toBe('deepseek-chat');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('probe returns auth error when API returns 401', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockCreate.mockRejectedValue(err);

    const result = await provider.probe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('auth');
    }
  });

  it('probe uses probeModel override', async () => {
    mockCreate.mockResolvedValue({
      id: 'test',
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });

    const customProvider = new DeepSeekProvider({ ...baseConfig, probeModel: 'deepseek-chat' });
    await customProvider.probe();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-chat' })
    );
  });
});

import type { ChatStreamChunk } from './types.js';

describe('DeepSeekProvider.chatStream', () => {
  it('yields sequential deltas then a terminal done chunk', async () => {
    const provider = new DeepSeekProvider({
      name: 'deepseek', apiKey: 'k', baseURL: 'https://api.deepseek.com',
      capabilities: ['chat'], models: { chat: 'deepseek-chat' }, timeoutMs: 5000,
    });
    mockCreate.mockImplementationOnce(async function* () {
      yield { choices: [{ delta: { content: '你' }, finish_reason: null }] };
      yield { choices: [{ delta: { content: '好' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    } as any);

    const out: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream({ messages: [{ role:'user', content:'hi' }] })) out.push(c);

    expect(out).toEqual([
      { delta: '你', done: false, finishReason: null },
      { delta: '好', done: false, finishReason: null },
      { delta: '', done: false, finishReason: 'stop' },
      { delta: '', done: true },
    ]);
  });

  it('throws ClassifiedError on network failure', async () => {
    const provider = new DeepSeekProvider({
      name: 'deepseek', apiKey: 'k', baseURL: 'https://api.deepseek.com',
      capabilities: ['chat'], models: { chat: 'deepseek-chat' }, timeoutMs: 5000,
    });
    mockCreate.mockImplementationOnce(async function* () {
      throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
    } as any);

    await expect(async () => {
      for await (const _ of provider.chatStream({ messages: [{ role:'user', content:'hi' }] })) { /* drain */ }
    }).rejects.toMatchObject({ kind: 'network' });
  });
});