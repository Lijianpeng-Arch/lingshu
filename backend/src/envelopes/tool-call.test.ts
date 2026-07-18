/**
 * envelopes/tool-call tests (V6 ACUI 协议扩展)
 *
 *   - emitToolCall fan-out to subscribers
 *   - subscribe returns unsubscriber
 *   - 测试清除 helper
 *   - event shape 类型守卫 (compile-time check, runtime smoke)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitToolCall,
  subscribeToolCallEvents,
  _clearToolCallHandlersForTest,
  _toolCallHandlerCountForTest,
  type ToolCallStartEvent,
  type ToolCallArgsDeltaEvent,
  type ToolCallResultEvent,
} from './tool-call.js';

describe('envelopes/tool-call', () => {
  beforeEach(() => {
    _clearToolCallHandlersForTest();
  });

  it('subscribeToolCallEvents returns an unsubscriber that detaches the handler', () => {
    expect(_toolCallHandlerCountForTest()).toBe(0);
    const seen: Array<unknown> = [];
    const unsub = subscribeToolCallEvents((e) => seen.push(e));
    expect(_toolCallHandlerCountForTest()).toBe(1);

    emitToolCall({
      type: 'tool_call_start',
      toolCallId: 'tc1',
      name: 'read_file',
      displayName: '读取文件',
      displayDescription: '读取指定路径的文件内容',
      args: { path: '/tmp/a' },
      timestamp: 1700000000000,
    });
    expect(seen).toHaveLength(1);

    unsub();
    expect(_toolCallHandlerCountForTest()).toBe(0);

    emitToolCall({
      type: 'tool_call_start',
      toolCallId: 'tc2',
      name: 'read_file',
      displayName: '读取文件',
      displayDescription: '读取指定路径的文件内容',
      args: { path: '/tmp/b' },
      timestamp: 1700000001000,
    });
    expect(seen).toHaveLength(1); // 没增长
  });

  it('emitToolCall fans out to multiple subscribers', () => {
    const a: Array<unknown> = [];
    const b: Array<unknown> = [];
    const unsubA = subscribeToolCallEvents((e) => a.push(e));
    const unsubB = subscribeToolCallEvents((e) => b.push(e));

    emitToolCall({
      type: 'tool_call_result',
      toolCallId: 'tc',
      result: { ok: true },
      durationMs: 100,
      status: 'success',
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    unsubA();
    unsubB();
  });

  it('handles subscriber throwing — does not stop other subscribers', () => {
    const seen: Array<unknown> = [];
    // bad handler that throws
    subscribeToolCallEvents(() => {
      throw new Error('boom');
    });
    subscribeToolCallEvents((e) => seen.push(e));

    emitToolCall({
      type: 'tool_call_args_delta',
      toolCallId: 'tc',
      argsDelta: '{"path":',
    });

    expect(seen).toHaveLength(1);
  });

  it('ToolCallStartEvent shape carries name, displayName, args, risk, timestamp', () => {
    const seen: ToolCallStartEvent[] = [];
    subscribeToolCallEvents((e) => {
      if (e.type === 'tool_call_start') seen.push(e);
    });

    const evt: ToolCallStartEvent = {
      type: 'tool_call_start',
      toolCallId: 'tc-x',
      name: 'run_command',
      displayName: '执行命令',
      displayDescription: '在终端运行一条 shell 命令',
      args: { command: 'ls /tmp' },
      risk: 'medium',
      timestamp: 1700000000000,
    };
    emitToolCall(evt);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(evt);
  });

  it('ToolCallArgsDeltaEvent + ToolCallResultEvent shapes are preserved', () => {
    const seen: unknown[] = [];
    subscribeToolCallEvents((e) => seen.push(e));

    const delta: ToolCallArgsDeltaEvent = {
      type: 'tool_call_args_delta',
      toolCallId: 'tc',
      argsDelta: '"partial',
    };
    const result: ToolCallResultEvent = {
      type: 'tool_call_result',
      toolCallId: 'tc',
      result: { stdout: 'hello' },
      durationMs: 50,
      status: 'success',
    };
    emitToolCall(delta);
    emitToolCall(result);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(delta);
    expect(seen[1]).toEqual(result);
  });

  it('_clearToolCallHandlersForTest empties the subscriber list', () => {
    subscribeToolCallEvents(() => undefined);
    subscribeToolCallEvents(() => undefined);
    expect(_toolCallHandlerCountForTest()).toBe(2);
    _clearToolCallHandlersForTest();
    expect(_toolCallHandlerCountForTest()).toBe(0);
  });
});
