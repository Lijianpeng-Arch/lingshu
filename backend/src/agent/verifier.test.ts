/**
 * verifier.ts 测试 — checkAcceptance（LLM 二次校验）
 * 灵枢 V2 — Goal 系统
 *
 * 借鉴 OpenCode 的 LLM-as-judge 思路：让同一 provider 自我评估验收清单，
 * 返回结构化 JSON（passed + evidence），防止 agent 谎报完成。
 */

import { describe, it, expect, vi } from 'vitest';
import { checkAcceptance, type LLMProvider, type Verdict } from './verifier.js';
import type { AcceptanceCriterion } from './acceptance.js';

function makeMockLLM(jsonResponse: unknown): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue({
      text: typeof jsonResponse === 'string' ? jsonResponse : JSON.stringify(jsonResponse),
    }),
  };
}

describe('checkAcceptance', () => {
  it('returns allPass=true when all criteria pass', async () => {
    const llm = makeMockLLM({
      results: [
        { criterion: '测试全绿', passed: true, evidence: 'vitest 18/18 绿' },
        { criterion: '新增 commit', passed: true, evidence: 'abc1234 feat(...)' },
      ],
    });
    const criteria: AcceptanceCriterion[] = [
      { text: '测试全绿' },
      { text: '新增 commit' },
    ];
    const verdict: Verdict = await checkAcceptance(criteria, 'agent 上下文摘要', llm);
    expect(verdict.allPass).toBe(true);
    expect(verdict.results).toHaveLength(2);
    expect(verdict.results[0]?.passed).toBe(true);
    expect(verdict.results[1]?.passed).toBe(true);
  });

  it('returns allPass=false when any criterion fails', async () => {
    const llm = makeMockLLM({
      results: [
        { criterion: '测试全绿', passed: true, evidence: 'OK' },
        { criterion: '新增 commit', passed: false, evidence: '没找到新 commit' },
      ],
    });
    const criteria: AcceptanceCriterion[] = [
      { text: '测试全绿' },
      { text: '新增 commit' },
    ];
    const verdict = await checkAcceptance(criteria, 'ctx', llm);
    expect(verdict.allPass).toBe(false);
    expect(verdict.results[0]?.passed).toBe(true);
    expect(verdict.results[1]?.passed).toBe(false);
  });

  it('passes criteria text into the LLM prompt', async () => {
    const llm = makeMockLLM({
      results: [{ criterion: 'foo', passed: true, evidence: 'OK' }],
    });
    await checkAcceptance([{ text: 'foo' }], 'context-body', llm);
    const call = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { prompt: string; json: boolean };
    expect(call.json).toBe(true);
    expect(call.prompt).toContain('foo');
    expect(call.prompt).toContain('context-body');
  });

  it('numbers criteria in the prompt (1. 2. 3.)', async () => {
    const llm = makeMockLLM({
      results: [
        { criterion: 'a', passed: true, evidence: 'x' },
        { criterion: 'b', passed: false, evidence: 'y' },
      ],
    });
    await checkAcceptance([{ text: 'a' }, { text: 'b' }], 'ctx', llm);
    const call = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain('1. a');
    expect(call.prompt).toContain('2. b');
  });

  it('handles empty criteria list (returns allPass=true, empty results)', async () => {
    const llm = makeMockLLM({ results: [] });
    const verdict = await checkAcceptance([], 'ctx', llm);
    expect(verdict.allPass).toBe(true);
    expect(verdict.results).toHaveLength(0);
  });

  it('preserves criterion original text in results', async () => {
    const llm = makeMockLLM({
      results: [
        { criterion: '测试全绿', passed: true, evidence: 'evidence-1' },
      ],
    });
    const verdict = await checkAcceptance([{ text: '测试全绿' }], 'ctx', llm);
    expect(verdict.results[0]?.criterion).toBe('测试全绿');
    expect(verdict.results[0]?.evidence).toBe('evidence-1');
  });

  it('throws if LLM returns invalid JSON', async () => {
    const llm = makeMockLLM('not json {');
    await expect(
      checkAcceptance([{ text: 'foo' }], 'ctx', llm)
    ).rejects.toThrow();
  });

  it('treats missing result[i] as failed (defensive)', async () => {
    const llm = makeMockLLM({
      results: [
        { criterion: 'a', passed: true, evidence: 'OK' },
        // 缺第二条
      ],
    });
    const verdict = await checkAcceptance(
      [{ text: 'a' }, { text: 'b' }],
      'ctx',
      llm
    );
    expect(verdict.allPass).toBe(false);
  });
});