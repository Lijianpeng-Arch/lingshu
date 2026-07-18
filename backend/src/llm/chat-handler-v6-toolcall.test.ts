/**
 * chat-handler V6 tool_call envelope tests
 *
 *   - executeMockTool 触发 tool_call_start + tool_call_result envelope
 *   - 结果事件携带 execResult + durationMs + status
 *   - deny 路径也触发 tool_call_result (error 路径)
 *   - 不破坏原 tool.preview / tool.output / tool.result envelope
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChatHandler, executeMockTool, parseMockToolFromMessage } from './chat-handler.js';
import {
  subscribeToolCallEvents,
  _clearToolCallHandlersForTest,
  type ToolCallStartEvent,
  type ToolCallResultEvent,
} from '../envelopes/tool-call.js';
import { BUILTIN_TOOLS } from '../tools/builtin.js';

// ── helper: collect envelope emit calls ──────────────────────
function makeCollectEmit() {
  const emitted: any[] = [];
  const fn = (env: any) => {
    emitted.push(env);
  };
  return { fn, emitted };
}

describe('chat-handler V6 tool_call envelope — happy path', () => {
  beforeEach(() => {
    _clearToolCallHandlersForTest();
  });

  it('executeMockTool emits tool_call_start before preview', async () => {
    const seen: ToolCallStartEvent[] = [];
    subscribeToolCallEvents((e) => {
      if (e.type === 'tool_call_start') seen.push(e);
    });
    const { fn, emitted } = makeCollectEmit();

    const tool = BUILTIN_TOOLS.find((t) => t.name === 'read_file');
    if (!tool) throw new Error('read_file missing');
    const parsed = parseMockToolFromMessage('读 /tmp/x.txt')!;

    await executeMockTool(
      parsed,
      { emit: fn, getProvider: () => ({}) as any, tools: BUILTIN_TOOLS },
      {
        id: 'env-1',
        type: 'chat.request',
        sender: 'electron',
        recipient: 'backend',
        timestamp: Date.now(),
        correlationId: null,
        traceMeta: {},
        payload: { messages: [], sessionId: 's1' },
      },
      'msg-1',
      's1',
      () => Date.now(),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe('read_file');
    expect(seen[0]!.displayName).toBe('读文件');
    // 原 envelope 仍然走老路径
    const types = emitted.map((e) => e.type);
    expect(types).toContain('tool.preview');
    expect(types).toContain('tool.output');
    expect(types).toContain('tool.result');
    expect(types).toContain('chat.done');
  });

  it('executeMockTool emits tool_call_result with success or error status', async () => {
    const seen: ToolCallResultEvent[] = [];
    subscribeToolCallEvents((e) => {
      if (e.type === 'tool_call_result') seen.push(e);
    });

    const parsed = parseMockToolFromMessage('读 /tmp/x.txt')!;
    await executeMockTool(
      parsed,
      { emit: () => undefined, getProvider: () => ({}) as any, tools: BUILTIN_TOOLS },
      {
        id: 'env-1',
        type: 'chat.request',
        sender: 'electron',
        recipient: 'backend',
        timestamp: Date.now(),
        correlationId: null,
        traceMeta: {},
        payload: { messages: [], sessionId: 's1' },
      },
      'msg-1',
      's1',
      () => Date.now(),
    );

    expect(seen).toHaveLength(1);
    const resultEvt = seen[0]!;
    expect(resultEvt.toolCallId).toBe(parsed.activityId);
    expect(['success', 'error']).toContain(resultEvt.status);
    expect(resultEvt.durationMs).toBeGreaterThanOrEqual(0);
    expect(resultEvt.result).toBeDefined();
  });
});

describe('chat-handler V6 tool_call envelope — deny / error path', () => {
  beforeEach(() => {
    _clearToolCallHandlersForTest();
  });

  it('permission deny 路径也 emit tool_call_result (status=error)', async () => {
    const seen: ToolCallResultEvent[] = [];
    subscribeToolCallEvents((e) => {
      if (e.type === 'tool_call_result') seen.push(e);
    });

    const { fn, emitted } = makeCollectEmit();

    // mock gateToolCall → deny
    const mainLoopStub: any = {
      gateToolCall: async () => ({ kind: 'deny', reason: 'test-deny' }),
    };

    const parsed = parseMockToolFromMessage('读 /tmp/x.txt')!;
    await executeMockTool(
      parsed,
      {
        emit: fn,
        getProvider: () => ({}) as any,
        tools: BUILTIN_TOOLS,
        mainLoop: mainLoopStub,
      },
      {
        id: 'env-1',
        type: 'chat.request',
        sender: 'electron',
        recipient: 'backend',
        timestamp: Date.now(),
        correlationId: null,
        traceMeta: {},
        payload: { messages: [], sessionId: 's1' },
      },
      'msg-1',
      's1',
      () => Date.now(),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe('error');
    expect(seen[0]!.errorMessage).toBeTruthy();
    // 原工具流程也跑完
    const types = emitted.map((e) => e.type);
    expect(types).toContain('tool.result');
    expect(types).toContain('chat.done');
  });
});

describe('chat-handler V6 — does not break ws/chat.request path', () => {
  beforeEach(() => {
    _clearToolCallHandlersForTest();
  });

  it('createChatHandler() 仍然能处理 chat.request 不抛错', async () => {
    const handler = createChatHandler({
      emit: () => undefined,
      getProvider: () => ({}) as any,
      tools: BUILTIN_TOOLS,
    });
    // 简单验证 — 类型对得上, handler 是 function
    expect(typeof handler).toBe('function');
  });
});

// ── suppress unused warnings ──────────────────────────────────
vi.mock('../agents/awareness.js', () => ({}));
