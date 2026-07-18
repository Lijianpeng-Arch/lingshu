import { describe, it, expect } from 'vitest';
import {
  CapabilitySchema,
  ProviderConfigSchema,
  ChatMessageSchema,
  ProbeResultSchema,
} from './types.js';

describe('CapabilitySchema', () => {
  it('accepts valid capabilities', () => {
    expect(CapabilitySchema.parse('chat')).toBe('chat');
    expect(CapabilitySchema.parse('embedding')).toBe('embedding');
    expect(CapabilitySchema.parse('tool_use')).toBe('tool_use');
    expect(CapabilitySchema.parse('image')).toBe('image');
    expect(CapabilitySchema.parse('tts')).toBe('tts');
    expect(CapabilitySchema.parse('stt')).toBe('stt');
  });

  it('rejects invalid capability', () => {
    expect(() => CapabilitySchema.parse('unknown')).toThrow();
  });
});

describe('ProviderConfigSchema', () => {
  it('accepts a valid config', () => {
    const config = ProviderConfigSchema.parse({
      name: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      capabilities: ['chat', 'embedding'],
      models: { chat: 'deepseek-chat' },
    });
    expect(config.name).toBe('deepseek');
    expect(config.capabilities).toEqual(['chat', 'embedding']);
    expect(config.timeoutMs).toBe(15_000); // default
  });

  it('rejects missing apiKey', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        name: 'test',
        baseURL: 'https://example.com',
        apiKey: '',
        capabilities: ['chat'],
      })
    ).toThrow();
  });

  it('rejects empty capabilities', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        name: 'test',
        baseURL: 'https://example.com',
        apiKey: 'sk-test',
        capabilities: [],
      })
    ).toThrow();
  });
});

describe('ChatMessageSchema', () => {
  it('accepts user/assistant/system/tool roles', () => {
    expect(ChatMessageSchema.parse({ role: 'user', content: 'hi' }).role).toBe('user');
    expect(ChatMessageSchema.parse({ role: 'assistant', content: 'hi' }).role).toBe('assistant');
    expect(ChatMessageSchema.parse({ role: 'system', content: 'hi' }).role).toBe('system');
    expect(ChatMessageSchema.parse({ role: 'tool', content: 'hi' }).role).toBe('tool');
  });

  it('rejects invalid role', () => {
    expect(() => ChatMessageSchema.parse({ role: 'bot', content: 'hi' })).toThrow();
  });
});

describe('ProbeResultSchema', () => {
  it('parses success result', () => {
    const r = ProbeResultSchema.parse({
      ok: true,
      provider: 'deepseek',
      capabilities: ['chat'],
      model: 'deepseek-chat',
      latencyMs: 200,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe('deepseek');
      expect(r.latencyMs).toBe(200);
    }
  });

  it('parses failure result with auth error', () => {
    const r = ProbeResultSchema.parse({
      ok: false,
      provider: 'deepseek',
      error: { kind: 'auth', message: 'invalid key' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('auth');
    }
  });
});
