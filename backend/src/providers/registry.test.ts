import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider,
  unregisterProvider,
  getProvider,
  getProviderByName,
  callCapability,
  listProviders,
  listCapabilities,
} from './registry.js';
import type { Provider, Capability, ChatRequest, ChatResponse, ProbeResult, ChatStreamChunk } from './types.js';

class FakeProvider implements Provider {
  constructor(
    readonly name: string,
    readonly capabilities: ReadonlyArray<Capability>
  ) {}
  canDo(c: Capability): boolean {
    return this.capabilities.includes(c);
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    return {
      id: 'fake-id',
      model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'fake' }, finish_reason: 'stop' }],
    };
  }
  async *chatStream(): AsyncIterable<ChatStreamChunk> {
    // no-op: FakeProvider only needs to satisfy the Provider interface for registry tests.
  }
  async probe(): Promise<ProbeResult> {
    return {
      ok: true,
      provider: this.name,
      capabilities: [...this.capabilities],
      model: 'fake-model',
      latencyMs: 0,
    };
  }
}

beforeEach(() => {
  for (const p of listProviders()) unregisterProvider(p.name);
});

describe('registerProvider', () => {
  it('registers a provider and getProvider returns it', () => {
    const p = new FakeProvider('fake-a', ['chat']);
    registerProvider(p);
    expect(getProvider('chat').name).toBe('fake-a');
  });

  it('re-registers (replaces) a provider with same name (hot-reload)', () => {
    const a = new FakeProvider('dup', ['chat']);
    const b = new FakeProvider('dup', ['chat', 'embedding']);
    registerProvider(a);
    registerProvider(b);
    expect(listProviders().filter((x) => x.name === 'dup')).toHaveLength(1);
    expect(getProviderByName('dup')?.capabilities).toContain('embedding');
  });
});

describe('getProvider', () => {
  it('returns the first provider that canDo the capability', () => {
    registerProvider(new FakeProvider('first', ['chat']));
    registerProvider(new FakeProvider('second', ['chat']));
    expect(getProvider('chat').name).toBe('first');
  });

  it('throws when no provider supports the capability', () => {
    expect(() => getProvider('image')).toThrow(/No provider supports/);
  });
});

describe('getProviderByName', () => {
  it('returns provider by name', () => {
    registerProvider(new FakeProvider('specific', ['chat']));
    expect(getProviderByName('specific')?.name).toBe('specific');
  });

  it('returns undefined for unknown name', () => {
    expect(getProviderByName('nope')).toBeUndefined();
  });
});

describe('callCapability', () => {
  it('routes to a provider that supports the capability', async () => {
    registerProvider(new FakeProvider('r', ['chat']));
    const res = await callCapability('chat', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.choices[0].message.content).toBe('fake');
  });
});

describe('listCapabilities', () => {
  it('returns the union of registered capabilities (deduped)', () => {
    registerProvider(new FakeProvider('a', ['chat', 'embedding']));
    registerProvider(new FakeProvider('b', ['chat', 'image']));
    const caps = listCapabilities();
    expect(caps.sort()).toEqual(['chat', 'embedding', 'image']);
  });

  it('returns empty array when no providers registered', () => {
    expect(listCapabilities()).toEqual([]);
  });
});

describe('unregisterProvider', () => {
  it('removes the provider', () => {
    registerProvider(new FakeProvider('rem', ['chat']));
    unregisterProvider('rem');
    expect(() => getProvider('chat')).toThrow();
  });

  it('is a no-op for unknown name', () => {
    expect(() => unregisterProvider('never-registered')).not.toThrow();
  });
});
