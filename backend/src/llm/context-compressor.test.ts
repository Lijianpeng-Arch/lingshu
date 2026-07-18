import { describe, it, expect } from 'vitest';
import {
  CompressType,
  ContextCompressor,
  ContextOverflowError,
  middleEvict,
  type Message,
} from './context-compressor.js';

const sys: Message = { role: 'system', content: 'You are helpful.' };

const makeMsgs = (n: number): Message[] => [
  sys,
  ...Array.from({ length: n }, (_, i) => ({
    role: 'user' as const,
    content: `msg ${i}`,
  })),
  { role: 'assistant' as const, content: 'reply' },
];

describe('ContextCompressor', () => {
  it.each([
    [CompressType.NO_COMPRESS, makeMsgs(10)],
    [CompressType.POST_CUT_BY_MSG, makeMsgs(30)],
    [CompressType.POST_CUT_BY_TOKEN, makeMsgs(50)],
    [CompressType.PRE_CUT_BY_MSG, makeMsgs(30)],
    [CompressType.PRE_CUT_BY_TOKEN, makeMsgs(50)],
  ])('compressMessages type=%s returns shorter-or-equal result preserving system', (type, msgs) => {
    const c = new ContextCompressor();
    const out = c.compressMessages(msgs, type);
    expect(out.length).toBeLessThanOrEqual(msgs.length);
    expect(out[0]).toEqual(sys); // system always preserved
  });

  it('NO_COMPRESS returns a copy, not the same reference', () => {
    const msgs = makeMsgs(5);
    const c = new ContextCompressor();
    const out = c.compressMessages(msgs, CompressType.NO_COMPRESS);
    expect(out).toEqual(msgs);
    expect(out).not.toBe(msgs);
  });

  it('POST_CUT_BY_MSG keeps last N messages + system', () => {
    const c = new ContextCompressor({ keepMsgCount: 5 });
    const msgs = makeMsgs(20); // 1 sys + 20 user + 1 assistant = 22
    const out = c.compressMessages(msgs, CompressType.POST_CUT_BY_MSG);
    expect(out.length).toBe(1 + 5); // sys + last 5
    expect(out[0]).toEqual(sys);
    expect(out[out.length - 1].content).toBe('reply'); // last assistant msg preserved
  });

  it('PRE_CUT_BY_MSG keeps first N messages + system', () => {
    const c = new ContextCompressor({ keepMsgCount: 5 });
    const msgs = makeMsgs(20);
    const out = c.compressMessages(msgs, CompressType.PRE_CUT_BY_MSG);
    expect(out.length).toBe(1 + 5);
    expect(out[0]).toEqual(sys);
    expect(out[1].content).toBe('msg 0'); // first user msg preserved
  });

  it('POST_CUT_BY_TOKEN respects token budget', () => {
    const c = new ContextCompressor({ tokenBudget: 60 });
    // 每条 'msg N' 大约 5 chars / 4 ≈ 2 tokens, +4 结构开销 = 6 tokens
    // budget=60 可容 ~10 条
    const msgs = makeMsgs(50);
    const out = c.compressMessages(msgs, CompressType.POST_CUT_BY_TOKEN);
    const totalTokens = c.countTokens(out);
    expect(totalTokens).toBeLessThanOrEqual(60 * 1.1 + 1); // 容忍倍数
    expect(out.length).toBeLessThan(msgs.length);
    expect(out[0]).toEqual(sys);
  });

  it('shouldCompress: false when below threshold', () => {
    const c = new ContextCompressor({ tokenBudget: 100 });
    const small: Message[] = [{ role: 'user', content: 'hi' }];
    expect(c.shouldCompress(small)).toBe(false);
  });

  it('shouldCompress: true when above threshold', () => {
    const c = new ContextCompressor({ tokenBudget: 100 });
    const big: Message[] = [{ role: 'user', content: 'x'.repeat(800) }]; // ~200 tokens
    expect(c.shouldCompress(big, 0.5)).toBe(true);
  });

  it('throws ContextOverflowError after multi-pass compression still overflows', () => {
    const c = new ContextCompressor({ tokenBudget: 50, keepMsgCount: 5 });
    // 每个 1KB ≈ 250 tokens,即使砍到只剩 5 条,每条仍 ~250 tokens,远超 budget=50
    const msgs: Message[] = [
      sys,
      ...Array.from({ length: 100 }, (_, i) => ({
        role: 'user' as const,
        content: 'x'.repeat(1000),
      })),
    ];
    expect(() => c.compressMessages(msgs, CompressType.POST_CUT_BY_TOKEN)).toThrow(
      ContextOverflowError,
    );
  });

  it('ContextOverflowError carries code=context_overflow', () => {
    const err = new ContextOverflowError();
    expect(err.code).toBe('context_overflow');
    expect(err).toBeInstanceOf(Error);
  });

  it('estimateTokens uses ceil(length/4)', () => {
    const c = new ContextCompressor();
    expect(c.estimateTokens('')).toBe(0);
    expect(c.estimateTokens('abcd')).toBe(1);
    expect(c.estimateTokens('abcde')).toBe(2);
    expect(c.estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('middleEvict', () => {
  it('keeps head N + tail N, replaces middle with NOTE', () => {
    const msgs: Message[] = [
      sys,
      { role: 'user', content: 'h1' },
      { role: 'assistant', content: 'h2' },
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
      { role: 'assistant', content: 't1' },
      { role: 'user', content: 't2' },
    ];
    const out = middleEvict(msgs, 2, 2);
    // sys + 2 head + 1 NOTE + 2 tail = 6
    expect(out.length).toBe(1 + 2 + 1 + 2);
    expect(out[0]).toEqual(sys);
    expect(out[1].content).toBe('h1');
    expect(out[2].content).toBe('h2');
    expect(out[3].role).toBe('system');
    expect(out[3].content).toContain('Middle evicted');
    expect(out[4].content).toBe('t1');
    expect(out[5].content).toBe('t2');
  });

  it('returns original when not enough messages to evict', () => {
    const msgs: Message[] = [
      sys,
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const out = middleEvict(msgs, 2, 4);
    expect(out).toBe(msgs); // too few to split
  });

  it('compressWithMiddleEvict chains POST_CUT_BY_TOKEN + middleEvict', () => {
    const c = new ContextCompressor({ tokenBudget: 200 });
    const msgs = makeMsgs(50);
    const out = c.compressWithMiddleEvict(msgs);
    expect(out.length).toBeLessThan(msgs.length);
    expect(out[0]).toEqual(sys);
    // Should contain either real messages or NOTE marker
    const hasNote = out.some((m) => m.content.includes('Middle evicted'));
    // If POST_CUT alone was enough, no NOTE; otherwise yes. Both acceptable.
    if (c.countTokens(out) > 200 * 1.1) {
      expect(hasNote).toBe(true);
    }
  });

  it('compressWithMiddleEvict does not throw on extreme input', () => {
    const c = new ContextCompressor({ tokenBudget: 50 });
    const msgs: Message[] = [
      sys,
      ...Array.from({ length: 100 }, () => ({
        role: 'user' as const,
        content: 'x'.repeat(1000),
      })),
    ];
    // Should produce a result without throwing (unlike compressMessages)
    const out = c.compressWithMiddleEvict(msgs);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toEqual(sys);
  });
});
