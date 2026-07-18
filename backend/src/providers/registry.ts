/**
 * Provider Registry — 能力路由
 *
 * 设计来源：BaiLongma `src/providers/registry.js`
 * 类型化版本 + 热替换支持
 */

import type { Capability, Provider, ChatRequest, ChatResponse } from './types.js';

// Phase 1: only chat and tool_use are implemented in provider.chat()
// Phase 2 will add embedding/image/tts/stt as Provider interface grows
const PHASE1_IMPLEMENTED_CAPABILITIES = new Set<Capability>(['chat', 'tool_use']);

const providers: Provider[] = [];

export function registerProvider(provider: Provider): void {
  const idx = providers.findIndex((p) => p.name === provider.name);
  if (idx >= 0) {
    // 热替换：同名 Provider 重新注册
    providers.splice(idx, 1, provider);
    return;
  }
  providers.push(provider);
}

export function unregisterProvider(name: string): void {
  const idx = providers.findIndex((p) => p.name === name);
  if (idx >= 0) providers.splice(idx, 1);
}

export function getProvider(capability: Capability): Provider {
  const p = providers.find((p) => p.canDo(capability));
  if (!p) {
    const registered = providers.map((x) => x.name).join(', ') || '(none)';
    throw new Error(`No provider supports capability: "${capability}". Registered: ${registered}`);
  }
  return p;
}

export function getProviderByName(name: string): Provider | undefined {
  return providers.find((p) => p.name === name);
}

export async function callCapability(
  capability: Capability,
  req: ChatRequest
): Promise<ChatResponse> {
  const provider = getProvider(capability);
  if (!provider.canDo(capability)) {
    throw new Error(
      `Provider ${provider.name} registered but canDo('${capability}') returned false`
    );
  }
  if (!PHASE1_IMPLEMENTED_CAPABILITIES.has(capability)) {
    throw new Error(`Capability "${capability}" not yet implemented in Phase 1`);
  }
  return provider.chat(req);
}

export function listCapabilities(): Capability[] {
  const caps = new Set<Capability>();
  for (const p of providers) {
    for (const c of p.capabilities) caps.add(c);
  }
  return [...caps];
}

export function listProviders(): Provider[] {
  return [...providers];
}
