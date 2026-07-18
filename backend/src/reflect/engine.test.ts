/**
 * Reflect — engine tests (Spec 1 反思循环 W3)
 *
 * 覆盖:
 *   1. trigger 4 类 (goal_complete / plan_completed / idle / error_threshold)
 *   2. cooldown 限制
 *   3. LLM 抛错 → 静默, 返回 null
 *   4. forceReflect 立即执行, 不检查 cooldown
 *   5. listRecent 正确返回
 *   6. 5s 超时 (mock LLM 慢) → null
 *   7. 中文 prompt 输出
 *   8. 写入 memory/thought (mock)
 *   9. forceReflect 在 LLM 抛错时返回 unclear 占位 (不返回 null)
 *  10. 同一 trigger 多次反思 → listRecent 累计
 *  11. cooldown reset 后立即可再触发
 *  12. 不同 trigger 互不影响 cooldown
 *  13. writeThought 抛错不阻塞反思结果
 *  14. emit 了 reflection.started + reflection.completed 两个事件
 *  15. verdict 非法值 → 收敛到 'unclear'
 *  16. JSON parse 失败 → null
 *  17. evidence 数组过滤非字符串
 *  18. triggerKey 内部去重正确
 *  19. 反思历史超 1000 条 → 截断
 *  20. correction 可选字段正确处理
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createReflectionEngine,
  DEFAULT_REFLECT_TIMEOUT_MS,
  DEFAULT_REFLECT_COOLDOWN_MS,
} from './engine.js';
import { buildReflectPrompt, describeTrigger } from './prompt.js';
import type { LLMProvider } from '../agent/verifier.js';
import type { ReflectCtx } from './types.js';
import type { UACSEnvelope } from '../uacs/envelope.js';

function makeLLM(text: string | (() => Promise<{ text: string }>)): LLMProvider {
  if (typeof text === 'function') {
    return { complete: vi.fn(text) };
  }
  return {
    complete: vi.fn(async () => ({ text })),
  };
}

function makeCtx(): ReflectCtx {
  return {
    recentEnvelopes: [
      {
        id: 'env-1',
        type: 'tool.result',
        sender: 'tool',
        recipient: 'soul',
        timestamp: Date.now(),
        correlationId: null,
        traceMeta: {},
        payload: { toolName: 'read_file', ok: true, message: 'ok' },
      },
    ],
    recentTools: [{ name: 'read_file', ok: true, ms: 12 }],
    recentFeedback: [],
  };
}

function makeDeps(overrides: Partial<Parameters<typeof createReflectionEngine>[0]> = {}) {
  const emitted: UACSEnvelope[] = [];
  const writtenThoughts: Array<{ text: string; kind: string }> = [];
  const deps = {
    llm: makeLLM(JSON.stringify({
      hypothesis: '我假设直接读文件最快',
      action: '调用了 read_file',
      evidence: ['env-1'],
      verdict: 'efficient',
    })),
    emit: (env: UACSEnvelope) => { emitted.push(env); },
    writeThought: async (text: string, kind: 'reflection') => {
      writtenThoughts.push({ text, kind });
      return `thought-${writtenThoughts.length}`;
    },
    cooldownMs: 5 * 60 * 1000,
    timeoutMs: 5_000,
    ...overrides,
  };
  return { deps, emitted, writtenThoughts };
}

describe('createReflectionEngine — 4 类 trigger', () => {
  it('goal_complete: 写入 reflection + thought', async () => {
    const { deps, emitted, writtenThoughts } = makeDeps();
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('efficient');
    expect(r!.thoughtId).toBe('thought-1');
    expect(writtenThoughts).toHaveLength(1);
    expect(writtenThoughts[0].kind).toBe('reflection');
    // emit started + completed
    expect(emitted).toHaveLength(2);
    expect(((emitted[0].payload as Record<string, unknown>).kind)).toBe('reflection.started');
    expect(((emitted[1].payload as Record<string, unknown>).kind)).toBe('reflection.completed');
  });

  it('plan_completed: durationMs 嵌入 prompt', async () => {
    const { deps } = makeDeps({
      llm: makeLLM(JSON.stringify({ hypothesis: 'x', action: 'y', evidence: [], verdict: 'efficient' })),
    });
    const engine = createReflectionEngine(deps);
    await engine.maybeReflect({ kind: 'plan_completed', planId: 'p-1', durationMs: 12345 }, makeCtx());
    const call = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain('12345');
    expect(call.prompt).toContain('p-1');
  });

  it('idle: idleMinutes 嵌入 prompt', async () => {
    const { deps } = makeDeps();
    const engine = createReflectionEngine(deps);
    await engine.maybeReflect({ kind: 'idle', idleMinutes: 30 }, makeCtx());
    const call = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain('30');
    expect(call.prompt).toContain('空闲');
  });

  it('error_threshold: windowSec/count 嵌入 prompt', async () => {
    const { deps } = makeDeps();
    const engine = createReflectionEngine(deps);
    await engine.maybeReflect({ kind: 'error_threshold', windowSec: 300, count: 5 }, makeCtx());
    const call = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain('300');
    expect(call.prompt).toContain('5');
    expect(call.prompt).toContain('错误超阈');
  });
});

describe('createReflectionEngine — cooldown', () => {
  it('同 trigger 冷却期内再次调用 → 返回 null 不调 LLM', async () => {
    const { deps } = makeDeps({ cooldownMs: 60_000 });
    const engine = createReflectionEngine(deps);
    const r1 = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r1).not.toBeNull();
    expect(deps.llm.complete).toHaveBeenCalledTimes(1);

    const r2 = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r2).toBeNull();
    expect(deps.llm.complete).toHaveBeenCalledTimes(1); // 没再调
  });

  it('resetCooldowns 后立即可再触发', async () => {
    const { deps } = makeDeps({ cooldownMs: 60_000 });
    const engine = createReflectionEngine(deps);
    await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    engine.resetCooldowns();
    const r2 = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r2).not.toBeNull();
  });

  it('不同 trigger 互不影响 cooldown', async () => {
    const { deps } = makeDeps({ cooldownMs: 60_000 });
    const engine = createReflectionEngine(deps);
    await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    const r2 = await engine.maybeReflect({ kind: 'idle', idleMinutes: 30 }, makeCtx());
    expect(r2).not.toBeNull();
    expect(deps.llm.complete).toHaveBeenCalledTimes(2);
  });

  it('默认 cooldown 是 5 分钟', () => {
    expect(DEFAULT_REFLECT_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });
});

describe('createReflectionEngine — LLM 抛错/超时', () => {
  it('LLM.complete 抛错 → 返回 null, 不挂', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = makeDeps({
      llm: { complete: vi.fn(async () => { throw new Error('LLM down'); }) },
    });
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('[reflect]'), expect.anything());
    consoleWarn.mockRestore();
  });

  it('LLM 慢 (5s 不返回) → 超时返回 null', async () => {
    const { deps } = makeDeps({
      llm: makeLLM(() => new Promise((resolve) => setTimeout(() => resolve({ text: '{"hypothesis":"x","action":"y","evidence":[],"verdict":"efficient"}' }), 10_000)),
      ),
      timeoutMs: 50, // 加速测试
    });
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-2' }, makeCtx());
    expect(r).toBeNull();
  });

  it('默认 timeout 是 5s', () => {
    expect(DEFAULT_REFLECT_TIMEOUT_MS).toBe(5_000);
  });

  it('JSON parse 失败 → 返回 null', async () => {
    const { deps } = makeDeps({ llm: makeLLM('this is not json at all') });
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-3' }, makeCtx());
    expect(r).toBeNull();
  });

  it('verdict 非法值 → 收敛到 unclear', async () => {
    const { deps } = makeDeps({
      llm: makeLLM(JSON.stringify({ hypothesis: 'h', action: 'a', evidence: ['e'], verdict: 'bogus' })),
    });
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-4' }, makeCtx());
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('unclear');
  });
});

describe('createReflectionEngine — forceReflect', () => {
  it('forceReflect 绕过 cooldown 立即执行', async () => {
    const { deps } = makeDeps({ cooldownMs: 60_000 });
    const engine = createReflectionEngine(deps);
    await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    const r = await engine.forceReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r).not.toBeNull();
    expect(deps.llm.complete).toHaveBeenCalledTimes(2);
  });

  it('forceReflect 在 LLM 抛错时返回 unclear 占位, 不返回 null', async () => {
    const { deps } = makeDeps({
      llm: { complete: vi.fn(async () => { throw new Error('fail'); }) },
    });
    const engine = createReflectionEngine(deps);
    const r = await engine.forceReflect({ kind: 'idle', idleMinutes: 30 }, makeCtx());
    expect(r).not.toBeNull();
    expect(r.verdict).toBe('unclear');
    expect(r.hypothesis).toBe('');
  });
});

describe('createReflectionEngine — listRecent', () => {
  it('空 history → 空数组', () => {
    const { deps } = makeDeps();
    const engine = createReflectionEngine(deps);
    expect(engine.listRecent(10)).toEqual([]);
  });

  it('多次反思 → listRecent 正确返回历史', async () => {
    const { deps } = makeDeps({ cooldownMs: 0 });
    const engine = createReflectionEngine(deps);
    for (let i = 0; i < 3; i++) {
      await engine.maybeReflect({ kind: 'goal_complete', goalId: `g-${i}` }, makeCtx());
    }
    const list = engine.listRecent(10);
    expect(list).toHaveLength(3);
    // 顺序按 push 顺序 (旧 → 新)
    expect(list[0]!.trigger).toEqual({ kind: 'goal_complete', goalId: 'g-0' });
    expect(list[2]!.trigger).toEqual({ kind: 'goal_complete', goalId: 'g-2' });
  });

  it('listRecent(limit) 限制返回数量', async () => {
    const { deps } = makeDeps({ cooldownMs: 0 });
    const engine = createReflectionEngine(deps);
    for (let i = 0; i < 5; i++) {
      await engine.maybeReflect({ kind: 'goal_complete', goalId: `g-${i}` }, makeCtx());
    }
    expect(engine.listRecent(2)).toHaveLength(2);
  });
});

describe('createReflectionEngine — 中文 prompt', () => {
  it('prompt 包含中文标记 + 结构化要求', async () => {
    const { deps } = makeDeps();
    const engine = createReflectionEngine(deps);
    await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    const call = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { prompt: string; json: boolean };
    expect(call.json).toBe(true);
    expect(call.prompt).toContain('你是一个自我反思引擎');
    expect(call.prompt).toContain('hypothesis');
    expect(call.prompt).toContain('verdict');
    expect(call.prompt).toContain('efficient');
    expect(call.prompt).toContain('correction');
  });

  it('prompt 包含 envelope/tool/feedback 上下文', async () => {
    const { deps } = makeDeps();
    const engine = createReflectionEngine(deps);
    const ctx: ReflectCtx = {
      recentEnvelopes: [
        {
          id: 'env-X',
          type: 'tool.result',
          sender: 'tool',
          recipient: 'soul',
          timestamp: 0,
          correlationId: null,
          traceMeta: {},
          payload: { toolName: 'write_file', ok: false, errorKind: 'permission_denied' },
        },
      ],
      recentTools: [{ name: 'write_file', ok: false, ms: 200 }],
      recentFeedback: [{ kind: 'deny', text: 'no permission' }],
    };
    await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, ctx);
    const call = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain('env-X');
    expect(call.prompt).toContain('write_file');
    expect(call.prompt).toContain('FAIL');
    expect(call.prompt).toContain('deny');
    expect(call.prompt).toContain('no permission');
  });

  it('describeTrigger 输出中文', () => {
    expect(describeTrigger({ kind: 'goal_complete', goalId: 'g1' })).toContain('目标完成');
    expect(describeTrigger({ kind: 'plan_completed', planId: 'p1', durationMs: 100 })).toContain('计划完成');
    expect(describeTrigger({ kind: 'idle', idleMinutes: 30 })).toContain('空闲');
    expect(describeTrigger({ kind: 'error_threshold', windowSec: 60, count: 3 })).toContain('错误超阈');
  });

  it('buildReflectPrompt 直接调用可用', () => {
    const prompt = buildReflectPrompt(
      { kind: 'idle', idleMinutes: 5 },
      { recentEnvelopes: [], recentTools: [], recentFeedback: [] },
    );
    expect(prompt).toContain('5');
    expect(prompt).toContain('空闲');
  });
});

describe('createReflectionEngine — writeThought 失败不影响主路径', () => {
  it('writeThought 抛错 → reflection 仍返回, 但 thoughtId 未设置', async () => {
    const { deps, emitted } = makeDeps({
      writeThought: async () => { throw new Error('sqlite down'); },
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r).not.toBeNull();
    expect(r!.thoughtId).toBeUndefined();
    // emit 仍然发出 started + completed
    expect(emitted).toHaveLength(2);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('writeThought'), expect.anything());
    consoleWarn.mockRestore();
  });
});

describe('createReflectionEngine — 历史上限', () => {
  it('超过 1000 条 → 截断最旧的 (FIFO)', async () => {
    const { deps } = makeDeps({ cooldownMs: 0 });
    const engine = createReflectionEngine(deps);
    // 用 forceReflect 绕过 cooldown, 直接 push 1001 条
    for (let i = 0; i < 1001; i++) {
      await engine.forceReflect({ kind: 'idle', idleMinutes: i % 60 }, makeCtx());
    }
    expect(engine.listRecent(2000)).toHaveLength(1000);
  });
});

describe('createReflectionEngine — evidence 数组过滤', () => {
  it('evidence 中非字符串元素被丢弃', async () => {
    const { deps } = makeDeps({
      llm: makeLLM(JSON.stringify({
        hypothesis: 'h',
        action: 'a',
        evidence: ['good', 123, null, 'also-good', false, true],
        verdict: 'wasteful',
      })),
    });
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r).not.toBeNull();
    expect(r!.evidence).toEqual(['good', 'also-good']);
  });

  it('correction 可选, verdict=efficient 时不强制设置', async () => {
    const { deps } = makeDeps({
      llm: makeLLM(JSON.stringify({ hypothesis: 'h', action: 'a', evidence: [], verdict: 'efficient' })),
    });
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r).not.toBeNull();
    expect(r!.correction).toBeUndefined();
  });

  it('correction=wrong 时存在', async () => {
    const { deps } = makeDeps({
      llm: makeLLM(JSON.stringify({
        hypothesis: 'h', action: 'a', evidence: [], verdict: 'wrong', correction: '下次应先查权限',
      })),
    });
    const engine = createReflectionEngine(deps);
    const r = await engine.maybeReflect({ kind: 'goal_complete', goalId: 'g-1' }, makeCtx());
    expect(r!.correction).toBe('下次应先查权限');
  });
});