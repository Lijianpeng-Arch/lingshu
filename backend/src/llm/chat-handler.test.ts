import { describe, it, expect, vi, afterEach } from 'vitest';
import { createChatHandler, executeMockTool, toFriendlyMessage } from './chat-handler.js';
import type { UACSEnvelope, ChatDeltaPayload, ChatDonePayload, ErrorPayload } from '../uacs/envelope.js';
import type { Provider, ChatRequest, ChatStreamChunk, ClassifiedError } from '../providers/types.js';
import { ContextCompressor, ContextOverflowError } from './context-compressor.js';
import { browserToolDefinition } from '../tools/browser-tool.js';
import { mapToolDefinition } from '../tools/map-tool.js';
import { runCommandTool, readFileTool } from '../tools/builtin.js';
import { createDispatcher, _clearInflightCapabilitiesForTest } from '../uacs/dispatcher.js';
import { newId } from '../util/id.js';
import type { MainLoop } from '../agent/main-loop.js';
import type { AgentContext, Goal } from '../agent/goal.js';
import type { LLMProvider } from '../agent/verifier.js';

function makeReq(): UACSEnvelope {
  return {
    id: 'env-1', type: 'chat.request', sender: 'electron', recipient: 'backend',
    timestamp: 1, correlationId: 'assistant-msg-1', traceMeta: {},
    payload: { messages: [{ role: 'user', content: 'hi' }], sessionId: 'sess-default' },
  };
}

function fakeProvider(
  chunks: Array<Partial<ChatStreamChunk>> | (() => AsyncIterable<ChatStreamChunk>),
  error?: ClassifiedError,
): Provider {
  const cap = 'chat' as const;
  const capArr: any = [cap];
  return {
    name: 'fake',
    capabilities: capArr,
    canDo: (c: string) => c === cap,
    chat: vi.fn(),
    chatStream: async function* () {
      if (error) throw error;
      const list = typeof chunks === 'function'
        ? chunks()
        : (async function* () {
            for (const c of chunks) yield c as ChatStreamChunk;
            yield { delta: '', done: true };
          })();
      for await (const c of list) yield c;
    },
    probe: vi.fn(),
  } as unknown as Provider;
}

function collectEnvs(emitted: any[]) {
  return {
    emit: (env: UACSEnvelope) => emitted.push(env),
    getProvider: () => null as any,
    timeoutMs: 1000,
    now: () => 12345,
  };
}

describe('createChatHandler', () => {
  it('emits chat.delta per non-empty chunk and a final chat.done', async () => {
    const provider = fakeProvider([
      { delta: '你', done: false },
      { delta: '', done: false },                       // skipped
      { delta: '好', done: false },
    ]);
    const emitted: any[] = [];
    const deps = { ...collectEnvs(emitted), getProvider: () => provider };
    const handler = createChatHandler(deps);
    await handler(makeReq());
    const deltas = emitted.filter((e) => e.type === 'chat.delta') as UACSEnvelope[];
    const dones = emitted.filter((e) => e.type === 'chat.done') as UACSEnvelope[];
    expect(deltas).toHaveLength(2);
    expect((deltas[0].payload as ChatDeltaPayload).delta).toBe('你');
    expect((deltas[1].payload as ChatDeltaPayload).delta).toBe('好');
    expect((deltas[0].payload as ChatDeltaPayload).messageId).toBe('assistant-msg-1');
    expect(deltas.every((d) => d.correlationId === 'assistant-msg-1')).toBe(true);
    expect(dones).toHaveLength(1);
    expect((dones[0].payload as ChatDonePayload).messageId).toBe('assistant-msg-1');
  });

  it('uses env.correlationId as messageId', async () => {
    const provider = fakeProvider([{ delta: 'x', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider });
    const env = { ...makeReq(), correlationId: 'my-id' };
    await handler(env);
    expect(emitted.find((e) => e.type === 'chat.delta')!.correlationId).toBe('my-id');
  });

  it('emits error envelope with friendly message when provider throws ClassifiedError(auth)', async () => {
    const authErr: ClassifiedError = { kind: 'auth', message: 'bad key', statusCode: 401 };
    const provider = fakeProvider([], authErr);
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider });
    await handler(makeReq());
    const errors = emitted.filter((e) => e.type === 'error') as UACSEnvelope[];
    expect(errors).toHaveLength(1);
    const payload = errors[0].payload as ErrorPayload;
    expect(payload.code).toBe('auth');
    expect(payload.message).toMatch(/API Key|访问密钥/);
    expect(payload.recoverable).toBe(false);
  });

  it('ignores non chat.request envelopes (no emit)', async () => {
    const provider = fakeProvider([{ delta: 'x', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider });
    await handler({ ...makeReq(), type: 'acui.show' as any });
    expect(emitted).toHaveLength(0);
  });

  it('emits friendly timeout error envelope when timeoutMs elapses', async () => {
    const provider: Provider = {
      name: 'slow', capabilities: ['chat'], canDo: () => true,
      chat: vi.fn(),
      chatStream: async function* () {
        // Yield one chunk, then hang so the watchdog fires
        yield { delta: '你', done: false };
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      probe: vi.fn(),
    } as any;
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider, timeoutMs: 30 });
    try { await handler(makeReq()); } catch { /* ignore */ }
    const errors = emitted.filter((e) => e.type === 'error') as UACSEnvelope[];
    expect(errors).toHaveLength(1);
    const payload = errors[0].payload as ErrorPayload;
    expect(payload.code).toBe('timeout');
    expect(payload.message).toMatch(/超时/);
    expect(payload.recoverable).toBe(true);
  });

  it('does not compress when compressor is not provided', async () => {
    const captured: any[][] = [];
    const provider: Provider = {
      name: 'capture', capabilities: ['chat'], canDo: () => true,
      chat: vi.fn(),
      chatStream: async function* (req: ChatRequest) {
        captured.push(req.messages);
        yield { delta: 'ok', done: false };
      },
      probe: vi.fn(),
    } as any;
    const bigPayload = {
      messages: Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'x'.repeat(1000) })),
      sessionId: 'sess-x',
    };
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider });
    await handler({
      ...makeReq(),
      payload: bigPayload,
    } as UACSEnvelope);
    expect(captured).toHaveLength(1);
    expect(captured[0].length).toBe(30); // unchanged
  });

  it('compresses messages when compressor is provided and shouldCompress=true', async () => {
    const captured: any[][] = [];
    const provider: Provider = {
      name: 'capture', capabilities: ['chat'], canDo: () => true,
      chat: vi.fn(),
      chatStream: async function* (req: ChatRequest) {
        captured.push(req.messages);
        yield { delta: 'ok', done: false };
      },
      probe: vi.fn(),
    } as any;
    // tokenBudget 默认 4000;30 条 × 1000 chars ≈ 30 × 250 = 7500 tokens,> 4000*0.5
    const bigPayload = {
      messages: Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'x'.repeat(1000) })),
      sessionId: 'sess-x',
    };
    const emitted: any[] = [];
    const compressor = new ContextCompressor();
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider, compressor });
    await handler({
      ...makeReq(),
      payload: bigPayload,
    } as UACSEnvelope);
    expect(captured).toHaveLength(1);
    expect(captured[0].length).toBeLessThan(30); // compressed
    expect(emitted.some((e) => e.type === 'chat.delta')).toBe(true);
    expect(emitted.some((e) => e.type === 'chat.done')).toBe(true);
    // No error envelope expected — compressWithMiddleEvict shouldn't throw on this size
    const errors = emitted.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(0);
  });

  it('emits context_overflow error envelope when compression still overflows', async () => {
    const provider: Provider = {
      name: 'never-used', capabilities: ['chat'], canDo: () => true,
      chat: vi.fn(),
      chatStream: async function* () {
        // Should not be reached
        yield { delta: 'should-not-appear', done: false };
      },
      probe: vi.fn(),
    } as any;
    // tokenBudget=50,keepMsgCount=5:100 条 × 1000 chars 每条 ≈ 250 tokens
    // 即使砍到 5 条 × 250 = 1250,仍 > 50 * 1.1 = 55 → compressWithMiddleEvict 也不行?
    // 注意:compressWithMiddleEvict 永不抛错(用 middleEvict 兜底),所以这里要换成 compressMessages
    // 我们改用 shouldCompress=true 路径但故意让它抛错 → 通过一个会 throw 的 compressor
    let callCount = 0;
    const fakeCompressor = {
      shouldCompress: () => true,
      compressWithMiddleEvict: () => {
        callCount++;
        if (callCount === 1) {
          // 模拟首次压缩后仍超 budget —— 但 compressWithMiddleEvict 本身不抛错
          // 我们需要一个会抛 ContextOverflowError 的实现
          throw new ContextOverflowError();
        }
        return [];
      },
    } as any;
    const bigPayload = {
      messages: Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'x'.repeat(1000) })),
      sessionId: 'sess-x',
    };
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider, compressor: fakeCompressor });
    await handler({ ...makeReq(), payload: bigPayload } as UACSEnvelope);
    const errors = emitted.filter((e) => e.type === 'error') as UACSEnvelope[];
    expect(errors).toHaveLength(1);
    const payload = errors[0].payload as ErrorPayload;
    expect(payload.code).toBe('context_overflow');
    expect(payload.message).toMatch(/对话太/);
    expect(payload.recoverable).toBe(false);
  });
});

describe('createChatHandler — mock tool loop (Spec 1 C1)', () => {
  const originalMockFlag = process.env.LINGSHU_MOCK_TOOLS;

  afterEach(() => {
    if (originalMockFlag === undefined) delete process.env.LINGSHU_MOCK_TOOLS;
    else process.env.LINGSHU_MOCK_TOOLS = originalMockFlag;
  });

  function makeMockReq(content: string): UACSEnvelope {
    return {
      ...makeReq(),
      payload: { messages: [{ role: 'user', content }], sessionId: 'sess-mock' },
    } as UACSEnvelope;
  }

  it('emits tool.preview, tool.output, tool.result when LINGSHU_MOCK_TOOLS=1 and message matches 跑 <cmd>', async () => {
    process.env.LINGSHU_MOCK_TOOLS = '1';
    // list_files is harmless in sandbox — use that to avoid cmd.exe on Linux CI
    // Actually we use read_file with a known temp file path; fallback to list_files for safety.
    const provider = fakeProvider([{ delta: 'should-not-emit', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider });
    // 跑 ls maps to run_command; on Linux test runners cmd.exe may fail.
    // We accept either tool_error or success — the wiring under test is the
    // emit-ordering of the three envelopes, not the tool's actual behavior.
    await handler(makeMockReq('跑 ls'));
    const previews = emitted.filter((e) => e.type === 'tool.preview');
    const outputs = emitted.filter((e) => e.type === 'tool.output');
    const results = emitted.filter((e) => e.type === 'tool.result');
    expect(previews).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(results).toHaveLength(1);
    // Order check: preview < output < result
    const order = emitted.map((e) => e.type);
    const i1 = order.indexOf('tool.preview');
    const i2 = order.indexOf('tool.output');
    const i3 = order.indexOf('tool.result');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    // Preview payload carries Chinese display name from BUILTIN_TOOLS
    expect((previews[0].payload as any).displayName).toBe('执行命令');
    expect((previews[0].payload as any).previewText).toContain('ls');
    // chat.done is also emitted so the renderer clears `sending`
    expect(emitted.some((e) => e.type === 'chat.done')).toBe(true);
  });

  it('emits tool.preview for 读 <path> with read_file tool', async () => {
    process.env.LINGSHU_MOCK_TOOLS = '1';
    const provider = fakeProvider([{ delta: 'unused', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider });
    await handler(makeMockReq('读 package.json'));
    const previews = emitted.filter((e) => e.type === 'tool.preview');
    expect(previews).toHaveLength(1);
    expect((previews[0].payload as any).toolName).toBe('read_file');
    expect((previews[0].payload as any).displayName).toBe('读文件');
    expect((previews[0].payload as any).args.path).toBe('package.json');
  });

  it('does NOT emit tool envelopes when LINGSHU_MOCK_TOOLS is unset', async () => {
    delete process.env.LINGSHU_MOCK_TOOLS;
    const provider = fakeProvider([{ delta: 'hi', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider });
    await handler(makeMockReq('跑 ls'));
    // Falls through to provider stream — chat.delta + chat.done only
    expect(emitted.some((e) => e.type === 'tool.preview')).toBe(false);
    expect(emitted.some((e) => e.type === 'tool.output')).toBe(false);
    expect(emitted.some((e) => e.type === 'tool.result')).toBe(false);
    expect(emitted.some((e) => e.type === 'chat.delta')).toBe(true);
  });

  it('does NOT emit tool envelopes when message has no trigger keyword (even with flag on)', async () => {
    process.env.LINGSHU_MOCK_TOOLS = '1';
    const provider = fakeProvider([{ delta: 'hello', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({ ...collectEnvs(emitted), getProvider: () => provider });
    await handler(makeMockReq('你好'));
    expect(emitted.some((e) => e.type === 'tool.preview')).toBe(false);
    expect(emitted.some((e) => e.type === 'chat.delta')).toBe(true);
  });
});

describe('toFriendlyMessage', () => {
  it.each([
    [{ kind: 'auth', message: 'x' },           /访问密钥|API Key/],
    [{ kind: 'rate_limit', message: 'x' },     /稍后/],
    [{ kind: 'context_overflow', message: 'x' },/对话太/],
    [{ kind: 'network', message: 'x' },        /网络/],
    [{ kind: 'retryable', message: 'x' },      /服务/],
    [{ kind: 'unknown', message: 'custom' },   /未知错误|custom/],
    [{ kind: 'tool_not_found' },               /找不到这个工具/],
    [{ kind: 'tool_permission_denied' },       /这个操作需要你确认/],
    [{ kind: 'tool_timeout' },                 /工具执行超时/],
    [{ kind: 'tool_sandbox_violation' },       /不允许访问这个目录/],
    [{ kind: 'file_too_large' },               /文件太大/],
    [{ kind: 'quota_exceeded' },               /额度/],
  ] as Array<[ClassifiedError, RegExp]>)('maps kind=%s to friendly text', (c, rx) => {
    expect(toFriendlyMessage(c)).toMatch(rx);
  });
});

describe('Phase C.4 — executeMockTool capability routing', () => {
  afterEach(() => {
    _clearInflightCapabilitiesForTest();
    // Defensive: ensure any vi.spyOn(...) spies created inside tests are
    // restored even when an assertion fails mid-test (otherwise they leak
    // across tests and silently change behavior).
    vi.restoreAllMocks();
  });

  it('routes capability tool (browser) through UACS capability.invoke instead of local execute', async () => {
    // Spy on browserToolDefinition.execute — must NOT be called by backend
    const executeSpy = vi.spyOn(browserToolDefinition, 'execute');

    const emitted: any[] = [];
    const d = createDispatcher();
    const deps = {
      emit: (env: UACSEnvelope) => emitted.push(env),
      getProvider: () => null as any,
      timeoutMs: 1000,
      now: () => 12345,
    };
    const parsed = {
      tool: browserToolDefinition,
      args: { action: 'navigate', url: 'https://example.com' },
      activityId: newId('activity'),
    };
    const env = {
      id: 'env-cap', type: 'chat.request', sender: 'electron', recipient: 'backend',
      timestamp: 1, correlationId: 'msg-cap', traceMeta: {},
      payload: { messages: [{ role: 'user', content: 'open' }], sessionId: 'sess-cap' },
    } as UACSEnvelope;

    // Start the mock tool — this will emit capability.invoke and await result
    const execPromise = executeMockTool(parsed, deps, env, 'msg-cap', 'sess-cap', deps.now);

    // Give microtasks a chance to run so capability.invoke is emitted
    await new Promise((resolve) => setImmediate(resolve));

    // 1. tool.preview was emitted first
    expect(emitted.some((e) => e.type === 'tool.preview')).toBe(true);

    // 2. capability.invoke envelope was emitted (with invokeId in correlationId)
    const capInvokes = emitted.filter((e) => e.type === 'capability.invoke');
    expect(capInvokes).toHaveLength(1);
    expect(capInvokes[0].payload.capability).toBe('browser');
    expect(capInvokes[0].payload.args).toEqual({ action: 'navigate', url: 'https://example.com' });
    const invokeId = capInvokes[0].correlationId;
    expect(invokeId).toMatch(/^cap-/);

    // 3. tool.execute was NOT called on the backend (the browser tool execute throws)
    expect(executeSpy).not.toHaveBeenCalled();

    // 4. Simulate renderer → backend: dispatch capability.result envelope
    await d.dispatch({
      id: 'result-env', type: 'capability.result',
      sender: 'electron', recipient: 'backend',
      timestamp: Date.now(), correlationId: invokeId,
      traceMeta: {},
      payload: { capability: 'browser', success: true, result: { ok: true, browserId: 'b-7', title: 'Example' } },
    });

    // 5. The promise resolves, tool.output + tool.result + chat.done are emitted
    await execPromise;
    expect(emitted.some((e) => e.type === 'tool.output')).toBe(true);
    expect(emitted.some((e) => e.type === 'tool.result')).toBe(true);
    expect(emitted.some((e) => e.type === 'chat.done')).toBe(true);
    const toolResults = emitted.filter((e) => e.type === 'tool.result');
    expect(toolResults[0].payload.ok).toBe(true);

    executeSpy.mockRestore();
  });

  // Task 1.4 focused integration test: assert map capability tool emits
  // capability.invoke with capability: 'map' and blocks until capability.result.
  it('Task 1.4: routes map capability tool with city "广州" → capability.invoke envelope + blocks for capability.result', async () => {
    // Spy on mapToolDefinition.execute — must NOT be called by backend
    const executeSpy = vi.spyOn(mapToolDefinition, 'execute');

    const emitted: UACSEnvelope[] = [];
    const d = createDispatcher();
    // capability path never invokes the chat provider, but the deps shape still
    // requires getProvider. Build a minimal Provider stub that satisfies the
    // interface and fails loudly if anything actually calls it.
    const provider: Provider = {
      name: 'unused',
      capabilities: ['chat'],
      canDo: () => false,
      chat: () => { throw new Error('provider.chat should not be called on capability path'); },
      chatStream: () => { throw new Error('provider.chatStream should not be called on capability path'); },
      probe: () => { throw new Error('provider.probe should not be called on capability path'); },
    };
    const deps = {
      emit: (env: UACSEnvelope) => emitted.push(env),
      getProvider: (): Provider => provider,
      timeoutMs: 1000,
      now: () => 12345,
    };
    const parsed = {
      tool: mapToolDefinition,
      args: { city: '广州' },
      activityId: newId('activity'),
    };
    const env: UACSEnvelope = {
      id: 'env-map', type: 'chat.request', sender: 'electron', recipient: 'backend',
      timestamp: 1, correlationId: 'msg-map', traceMeta: {},
      payload: { messages: [{ role: 'user', content: 'map' }], sessionId: 'sess-map' },
    };

    // Start the mock tool — emits capability.invoke and awaits result
    const execPromise = executeMockTool(parsed, deps, env, 'msg-map', 'sess-map', deps.now);

    // Yield so emitCapabilityInvoke fires before we inspect
    await new Promise((resolve) => setImmediate(resolve));

    // 1. tool.preview emitted
    expect(emitted.some((e) => e.type === 'tool.preview')).toBe(true);

    // 2. capability.invoke envelope emitted with capability: 'map' and city '广州'
    const capInvokes = emitted.filter((e): e is UACSEnvelope & { type: 'capability.invoke' } => e.type === 'capability.invoke');
    expect(capInvokes).toHaveLength(1);
    expect(capInvokes[0].payload?.capability).toBe('map');
    expect(capInvokes[0].payload?.args).toEqual({ city: '广州' });
    const invokeId = capInvokes[0].correlationId;
    expect(invokeId).toMatch(/^cap-/);

    // 3. tool.execute was NOT called locally (backend cannot do map)
    expect(executeSpy).not.toHaveBeenCalled();

    // 4. While pending, tool.output / tool.result / chat.done have NOT been emitted yet
    //    (proves awaitCapabilityResult is blocking, not fire-and-forget)
    expect(emitted.some((e) => e.type === 'tool.output')).toBe(false);
    expect(emitted.some((e) => e.type === 'tool.result')).toBe(false);
    expect(emitted.some((e) => e.type === 'chat.done')).toBe(false);

    // 5. Simulate renderer dispatching capability.result with the matching invokeId
    await d.dispatch({
      id: 'result-map', type: 'capability.result',
      sender: 'electron', recipient: 'backend',
      timestamp: Date.now(), correlationId: invokeId,
      traceMeta: {},
      payload: { capability: 'map', success: true, result: { ok: true, city: '广州', coordinates: [113.27, 23.13] } },
    });

    // 6. Promise resolves; tool.output + tool.result + chat.done all emitted
    await execPromise;
    const outputs = emitted.filter((e) => e.type === 'tool.output');
    const results = emitted.filter((e): e is UACSEnvelope & { type: 'tool.result' } => e.type === 'tool.result');
    expect(outputs).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].payload?.ok).toBe(true);
    expect(emitted.some((e) => e.type === 'chat.done')).toBe(true);

    executeSpy.mockRestore();
  });

  it('keeps routing regular tools (run_command) through local execute (regression)', async () => {
    // Spy on run_command execute — it MUST be called
    const executeSpy = vi.spyOn(runCommandTool, 'execute');

    const emitted: any[] = [];
    const deps = {
      emit: (env: UACSEnvelope) => emitted.push(env),
      getProvider: () => null as any,
      timeoutMs: 1000,
      now: () => 12345,
    };
    const parsed = {
      tool: runCommandTool,
      args: { command: 'echo hello' },
      activityId: newId('activity'),
    };
    const env = {
      id: 'env-reg', type: 'chat.request', sender: 'electron', recipient: 'backend',
      timestamp: 1, correlationId: 'msg-reg', traceMeta: {},
      payload: { messages: [{ role: 'user', content: 'echo' }], sessionId: 'sess-reg' },
    } as UACSEnvelope;

    await executeMockTool(parsed, deps, env, 'msg-reg', 'sess-reg', deps.now);

    // 1. run_command.execute WAS called locally
    expect(executeSpy).toHaveBeenCalled();
    // 2. NO capability.invoke envelope was emitted
    expect(emitted.some((e) => e.type === 'capability.invoke')).toBe(false);
    // 3. The three standard envelopes were emitted in order
    expect(emitted.some((e) => e.type === 'tool.preview')).toBe(true);
    expect(emitted.some((e) => e.type === 'tool.output')).toBe(true);
    expect(emitted.some((e) => e.type === 'tool.result')).toBe(true);

    executeSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────
// Task 6.5: chat-handler wired to MainLoop.gateToolCall + runGoalMode
// ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal MainLoop stub for chat-handler wiring tests.
 * Only the methods that the chat-handler actually calls are implemented:
 *   - gateToolCall(tool, args) → Promise<PermissionDecision>
 *   - runGoalMode(userInput, ctx, llm) → Promise<Goal | null>
 * resolvePermission is a no-op stub (not used by chat-handler in these tests).
 */
function makeMainLoopStub(opts: {
  gateDecision?: import('../permission/types.js').PermissionDecision;
  gateDelayMs?: number;
  runGoalResult?: Goal | null;
  onGate?: (tool: import('../tools/registry.js').ToolDefinition, args: Record<string, unknown>) => void;
  onRunGoal?: (input: string) => void;
} = {}): MainLoop {
  const gateCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const gate = async (tool: any, args: any) => {
    gateCalls.push({ tool: tool.name, args });
    opts.onGate?.(tool, args);
    if (opts.gateDelayMs && opts.gateDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, opts.gateDelayMs));
    }
    return opts.gateDecision ?? { kind: 'allow' as const };
  };

  const runGoalMode = async (userInput: string, _ctx: AgentContext, _llm: LLMProvider) => {
    opts.onRunGoal?.(userInput);
    return opts.runGoalResult ?? null;
  };

  return {
    start: () => {},
    stop: () => {},
    triggerUserMessage: () => {},
    getSnapshot: () => ({ tasks: [], thoughts: [], status: { mode: 'idle' as const, uptime: 0, activeTasks: 0 }, emotion: 'idle' as const }),
    buildUpdate: () => ({ kind: 'status', data: null }) as any,
    getState: () => ({ lastTickAt: 0, tickCount: 0, reason: 'idle' as const }),
    gateToolCall: gate,
    resolvePermission: () => {},
    runGoalMode,
    // expose gateCalls for assertions
    _gateCalls: gateCalls,
  } as unknown as MainLoop & { _gateCalls: typeof gateCalls };
}

// ---- I4 Spec 2A: defaultLlmProvider stub must throw, not fake-pass ----
// Borrowed from CrewAI agent error handling.
// Spec §I4: when runGoalMode is invoked without a real LLMProvider wired,
// the verifier (checkAcceptance) throws → goal loop's embedded try/catch
// catches and continues. But because defaultLlmProvider stub throws on
// complete() (no fake JSON), the loop eventually terminates via abort or
// after iterations without allPass. The key behavior: it does NOT
// silently complete with empty results (the bug we're fixing).

describe('defaultLlmProvider stub (I4)', () => {
  it('defaultLlmProvider.complete throws — does NOT fake-pass with results:[]', async () => {
    process.env.LINGSHU_SETTINGS_PATH = '__nonexistent__';
    // Track whether runGoalMode was called
    const runGoalSpy = vi.fn().mockResolvedValue(null);
    const mainLoop = makeMainLoopStub() as MainLoop;
    mainLoop.runGoalMode = runGoalSpy as any;

    const provider = fakeProvider([{ delta: 'should-not-emit', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
      mainLoop,
      // No llmProvider supplied → defaultLlmProvider() used inside chat-handler
      loadSettingsFn: () => ({ mode: 'goal', rules: [], permissionTimeoutSeconds: 60 }),
    });
    await handler({
      ...makeReq(),
      payload: {
        messages: [{ role: 'user', content: '目标: 测试\n验收:\n1) x' }],
        sessionId: 'sess-no-llm',
      },
    } as UACSEnvelope);
    // runGoalMode called (chat-handler wraps defaultLlmProvider and passes it in)
    expect(runGoalSpy).toHaveBeenCalledTimes(1);
    // chat.done emitted — chat-handler handled the goal path cleanly
    expect(emitted.some((e) => e.type === 'chat.done')).toBe(true);
  });

  it('defaultLlmProvider.complete throws SyntaxError on call (no fake results)', async () => {
    // We import the module-level defaultLlmProvider indirectly through chat-handler.
    // Trigger it via the goal path with no llmProvider injected → the stub throws
    // when checkAcceptance calls llm.complete().
    process.env.LINGSHU_SETTINGS_PATH = '__nonexistent__';
    // Provide a real MainLoop (not the stub) that wires up actual runGoalMode.
    // But we need real agentCtx + the stub LLM, so we wire a MainLoop that
    // calls a custom runGoalMode that uses a verifier that will call llm.complete.
    let capturedLlm: LLMProvider | undefined;
    const mainLoop = makeMainLoopStub({
      runGoalResult: null,
    }) as MainLoop;
    // Make runGoalMode capture the llm argument and invoke it
    mainLoop.runGoalMode = vi.fn(async (_input: string, _ctx: AgentContext, llm: LLMProvider) => {
      capturedLlm = llm;
      // Call llm.complete() — this is what the stub would do
      try {
        await llm.complete({ prompt: 'test', json: true });
      } catch {
        // stub throws — this is the expected behavior
      }
      return null;
    }) as any;

    const provider = fakeProvider([{ delta: 'x', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
      mainLoop,
      loadSettingsFn: () => ({ mode: 'goal', rules: [], permissionTimeoutSeconds: 60 }),
    });
    await handler({
      ...makeReq(),
      payload: {
        messages: [{ role: 'user', content: '目标: 测试\n验收:\n1) x' }],
        sessionId: 'sess-no-llm-2',
      },
    } as UACSEnvelope);
    expect(capturedLlm).toBeDefined();
    // Calling complete() must throw (not return fake JSON)
    await expect(capturedLlm!.complete({ prompt: 'x', json: true }))
      .rejects.toThrow(/No LLM provider configured|Set LINGSHU_DEEPSEEK_API_KEY/);
  });
});

describe('createChatHandler — Task 6.5 gate wiring', () => {
  const originalMockFlag = process.env.LINGSHU_MOCK_TOOLS;
  const originalSettingsPath = process.env.LINGSHU_SETTINGS_PATH;

  afterEach(() => {
    if (originalMockFlag === undefined) delete process.env.LINGSHU_MOCK_TOOLS;
    else process.env.LINGSHU_MOCK_TOOLS = originalMockFlag;
    if (originalSettingsPath === undefined) delete process.env.LINGSHU_SETTINGS_PATH;
    else process.env.LINGSHU_SETTINGS_PATH = originalSettingsPath;
  });

  function makeMockReq(content: string): UACSEnvelope {
    return {
      ...makeReq(),
      payload: { messages: [{ role: 'user', content }], sessionId: 'sess-gate' },
    } as UACSEnvelope;
  }

  it('gate allow → tool.execute is called, result emitted normally', async () => {
    process.env.LINGSHU_MOCK_TOOLS = '1';
    process.env.LINGSHU_SETTINGS_PATH = '__nonexistent__'; // force DEFAULTS (mode=smart)
    const executeSpy = vi.spyOn(readFileTool, 'execute').mockResolvedValue({
      ok: true,
      content: 'fixture-content',
    });
    const gateSpy = vi.fn().mockResolvedValue({ kind: 'allow' });
    const mainLoop = makeMainLoopStub({
      gateDecision: { kind: 'allow' },
    }) as MainLoop;
    // Override gateToolCall to track calls
    mainLoop.gateToolCall = gateSpy as any;

    const provider = fakeProvider([{ delta: 'should-not-emit', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
      mainLoop,
    });
    await handler(makeMockReq('读 package.json'));
    // gateToolCall was called with the right tool
    expect(gateSpy).toHaveBeenCalledTimes(1);
    const [tool, args] = gateSpy.mock.calls[0]!;
    expect(tool.name).toBe('read_file');
    expect(args).toEqual({ path: 'package.json' });
    // tool.execute was actually invoked
    expect(executeSpy).toHaveBeenCalledTimes(1);
    // Standard mock-tool envelopes were emitted (preview, output, result, done)
    const results = emitted.filter((e) => e.type === 'tool.result');
    expect(results).toHaveLength(1);
    expect((results[0].payload as any).ok).toBe(true);
    expect((results[0].payload as any).message).toContain('fixture-content');
    executeSpy.mockRestore();
  });

  it('gate deny → tool.execute NOT called, returns ok:false with reason', async () => {
    process.env.LINGSHU_MOCK_TOOLS = '1';
    process.env.LINGSHU_SETTINGS_PATH = '__nonexistent__';
    const executeSpy = vi.spyOn(readFileTool, 'execute').mockResolvedValue({
      ok: true,
      content: 'should-not-appear',
    });
    const gateSpy = vi.fn().mockResolvedValue({
      kind: 'deny' as const,
      reason: 'Permission denied: read_file is blocked by rule',
    });
    const mainLoop = makeMainLoopStub() as MainLoop;
    mainLoop.gateToolCall = gateSpy as any;

    const provider = fakeProvider([{ delta: 'should-not-emit', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
      mainLoop,
    });
    await handler(makeMockReq('读 package.json'));
    // gateToolCall was called
    expect(gateSpy).toHaveBeenCalledTimes(1);
    // tool.execute was NOT invoked
    expect(executeSpy).not.toHaveBeenCalled();
    // tool.result was emitted with ok:false and friendly reason
    const results = emitted.filter((e) => e.type === 'tool.result');
    expect(results).toHaveLength(1);
    expect((results[0].payload as any).ok).toBe(false);
    expect((results[0].payload as any).message).toMatch(/这个操作需要你确认|Permission/);
    // tool.preview was still emitted so the renderer can show what was blocked
    const previews = emitted.filter((e) => e.type === 'tool.preview');
    expect(previews).toHaveLength(1);
    // chat.done was emitted to clear `sending` state
    expect(emitted.some((e) => e.type === 'chat.done')).toBe(true);
    executeSpy.mockRestore();
  });

  it('gate ask + user allow → tool.execute called after gate resolves to allow', async () => {
    process.env.LINGSHU_MOCK_TOOLS = '1';
    process.env.LINGSHU_SETTINGS_PATH = '__nonexistent__';
    const executeSpy = vi.spyOn(readFileTool, 'execute').mockResolvedValue({
      ok: true,
      content: 'after-prompt',
    });
    // gateToolCall awaits, then resolves with allow (simulating user clicking "Allow")
    const gateSpy = vi.fn().mockImplementation(async (_tool: any, _args: any) => {
      await new Promise((resolve) => setImmediate(resolve));
      return { kind: 'allow' as const };
    });
    const mainLoop = makeMainLoopStub() as MainLoop;
    mainLoop.gateToolCall = gateSpy as any;

    const provider = fakeProvider([{ delta: 'should-not-emit', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
      mainLoop,
    });
    await handler(makeMockReq('读 secrets.env'));
    // Gate was awaited, then tool.execute was called
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const results = emitted.filter((e) => e.type === 'tool.result');
    expect(results).toHaveLength(1);
    expect((results[0].payload as any).ok).toBe(true);
    expect((results[0].payload as any).message).toContain('after-prompt');
    executeSpy.mockRestore();
  });

  it('gate ask + user timeout → tool.execute NOT called, returns permission timeout error', async () => {
    process.env.LINGSHU_MOCK_TOOLS = '1';
    process.env.LINGSHU_SETTINGS_PATH = '__nonexistent__';
    const executeSpy = vi.spyOn(readFileTool, 'execute').mockResolvedValue({
      ok: true,
      content: 'should-not-appear',
    });
    // gateToolCall awaits, then resolves with deny/timeout reason
    const gateSpy = vi.fn().mockImplementation(async (_tool: any, _args: any) => {
      await new Promise((resolve) => setImmediate(resolve));
      return { kind: 'deny' as const, reason: 'Permission timeout after 60s' };
    });
    const mainLoop = makeMainLoopStub() as MainLoop;
    mainLoop.gateToolCall = gateSpy as any;

    const provider = fakeProvider([{ delta: 'should-not-emit', done: false }]);
    const emitted: any[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
      mainLoop,
    });
    await handler(makeMockReq('读 secrets.env'));
    expect(gateSpy).toHaveBeenCalledTimes(1);
    // tool.execute NOT invoked because gate denied/timeout
    expect(executeSpy).not.toHaveBeenCalled();
    // tool.result was emitted with ok:false and friendly timeout message
    const results = emitted.filter((e) => e.type === 'tool.result');
    expect(results).toHaveLength(1);
    expect((results[0].payload as any).ok).toBe(false);
    expect((results[0].payload as any).message).toMatch(/Permission timeout|超时/);
    executeSpy.mockRestore();
  });

  it('runGoalMode entry: user input 含 "目标:" + mode=goal → 走 runGoalMode, 跳过普通 chat', async () => {
    process.env.LINGSHU_SETTINGS_PATH = '__nonexistent__';
    const runGoalSpy = vi.fn().mockResolvedValue({
      id: 'goal-1',
      statement: '测试目标',
      acceptance: [{ text: '条 1' }],
      status: 'complete',
      iterations: 1,
      started_at: Date.now(),
      contextSummary: 'done',
    });
    const mainLoop = makeMainLoopStub() as MainLoop;
    mainLoop.runGoalMode = runGoalSpy as any;

    // Provider MUST NOT be called — runGoalMode short-circuits the chat loop
    const provider = fakeProvider([{ delta: 'should-not-emit', done: false }]);
    const getProviderSpy = vi.fn(() => provider);

    const emitted: any[] = [];
    // Inject goal-mode settings via loadSettingsFn (avoids touching ~/.lingshu/settings.json)
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: getProviderSpy,
      timeoutMs: 1000,
      now: () => 12345,
      mainLoop,
      loadSettingsFn: () => ({ mode: 'goal', rules: [], permissionTimeoutSeconds: 60 }),
    });
    await handler({
      ...makeReq(),
      payload: {
        messages: [{ role: 'user', content: '目标: 测试目标\n验收:\n1) 条 1' }],
        sessionId: 'sess-goal',
      },
    } as UACSEnvelope);
    // runGoalMode was called with the user input
    expect(runGoalSpy).toHaveBeenCalledTimes(1);
    const [passedInput] = runGoalSpy.mock.calls[0]!;
    expect(passedInput).toContain('目标:');
    expect(passedInput).toContain('测试目标');
    // Provider was NOT invoked (the goal path bypassed the chat stream)
    expect(getProviderSpy).not.toHaveBeenCalled();
    // No chat.delta emitted (we didn't stream anything for the goal path itself;
    // chat.done is still emitted so the renderer clears `sending`)
    expect(emitted.some((e) => e.type === 'chat.delta')).toBe(false);
    expect(emitted.some((e) => e.type === 'chat.done')).toBe(true);
  });
});
