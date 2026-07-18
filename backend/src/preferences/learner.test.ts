import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSqlite } from '../db/sqlite.js';
import { createPreferenceStore } from './store.js';
import { createPreferenceLearner, type ExtractedPreference } from './learner.js';
import type { LLMProvider } from '../agent/verifier.js';

/**
 * Build a mock LLM. `complete` returns the provided text (or array of texts cycled by call index).
 */
function mockLLM(responses: string[]): LLMProvider & { callCount: () => number } {
  let idx = 0;
  let count = 0;
  return {
    complete: vi.fn(async (_req: unknown) => {
      count += 1;
      const text = responses[idx % responses.length];
      idx += 1;
      return { text };
    }),
    callCount: () => count,
  } as unknown as LLMProvider & { callCount: () => number };
}

function setupDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'lingshu-pref-'));
  return createSqlite(join(dir, 'pref.sqlite'));
}

describe('preferences/learner', () => {
  let db: Database.Database;
  beforeEach(() => { db = setupDb(); });

  it('learnFromMessage: LLM extracts 0 prefs → store unchanged', async () => {
    const store = createPreferenceStore(db);
    const llm = mockLLM(['[]']);
    const learner = createPreferenceLearner({ store, llm: llm as unknown as LLMProvider });
    const count = await learner.learnFromMessage('今天天气不错', '嗯是的');
    expect(count).toBe(0);
    expect(store.list()).toEqual([]);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('learnFromMessage: LLM extracts 1 pref → merge into store as inferred', async () => {
    const store = createPreferenceStore(db);
    const llm = mockLLM([JSON.stringify([{ key: 'default_mode', value: 'smart' }])]);
    const learner = createPreferenceLearner({ store, llm: llm as unknown as LLMProvider });
    const count = await learner.learnFromMessage('我更喜欢智能审核', '好的');
    expect(count).toBe(1);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].key).toBe('default_mode');
    expect(all[0].source).toBe('inferred');
    expect(store.get('default_mode')).toBe('smart');
  });

  it('learnFromMessage: LLM returns garbage → swallow error, store unchanged', async () => {
    const store = createPreferenceStore(db);
    const llm = mockLLM(['not json at all{{']);
    const learner = createPreferenceLearner({ store, llm: llm as unknown as LLMProvider });
    const count = await learner.learnFromMessage('foo', 'bar');
    expect(count).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it('learnFromMessage: multiple calls accumulate confidence', async () => {
    const store = createPreferenceStore(db);
    const llm = mockLLM([
      JSON.stringify([{ key: 'language', value: 'zh' }]),
      JSON.stringify([{ key: 'language', value: 'zh' }]),
      JSON.stringify([{ key: 'language', value: 'zh' }]),
    ]);
    const learner = createPreferenceLearner({ store, llm: llm as unknown as LLMProvider });
    await learner.learnFromMessage('a', 'b');
    await learner.learnFromMessage('c', 'd');
    const conf1 = store.list()[0].confidence;
    await learner.learnFromMessage('e', 'f');
    const conf2 = store.list()[0].confidence;
    expect(conf2).toBeGreaterThan(conf1);
    expect(conf2).toBeLessThanOrEqual(1.0);
  });

  it('learnFromMessage: explicit override wins over inferred (via merge)', async () => {
    const store = createPreferenceStore(db);
    const llm = mockLLM([JSON.stringify([{ key: 'default_mode', value: 'goal' }])]);
    const learner = createPreferenceLearner({ store, llm: llm as unknown as LLMProvider });
    await learner.learnFromMessage('m1', 'r1');
    // 显式接口调用覆盖
    learner.applyExplicit('default_mode', 'plan');
    const rec = store.list().find((p) => p.key === 'default_mode')!;
    expect(store.get('default_mode')).toBe('plan');
    expect(rec.source).toBe('explicit');
  });

  it('extractPreferences: returns parsed array (caller drives usage)', async () => {
    const store = createPreferenceStore(db);
    const llm = mockLLM([JSON.stringify([
      { key: 'a', value: 1 },
      { key: 'b', value: 'two' },
    ])]);
    const learner = createPreferenceLearner({ store, llm: llm as unknown as LLMProvider });
    const extracted = await learner.extractPreferences('msg');
    expect(extracted).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 'two' },
    ]);
  });

  it('learnFromMessage: LLM returns object instead of array → returns 0', async () => {
    const store = createPreferenceStore(db);
    const llm = mockLLM([JSON.stringify({ key: 'a', value: 1 })]);  // 不是 array
    const learner = createPreferenceLearner({ store, llm: llm as unknown as LLMProvider });
    const count = await learner.learnFromMessage('m', 'r');
    expect(count).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it('learnFromMessage: LLM returns array with non-object entries → skips them', async () => {
    const store = createPreferenceStore(db);
    const llm = mockLLM([JSON.stringify([
      { key: 'a', value: 1 },
      'not an object',
      null,
      { key: 'b', value: 2 },
    ])]);
    const learner = createPreferenceLearner({ store, llm: llm as unknown as LLMProvider });
    const count = await learner.learnFromMessage('m', 'r');
    expect(count).toBe(2);
    expect(store.list().map((p) => p.key).sort()).toEqual(['a', 'b']);
  });
});

describe('preferences/learner — ExtractedPreference schema', () => {
  it('ExtractedPreference type: structural shape (smoke)', () => {
    const sample: ExtractedPreference = { key: 'theme', value: 'dark', confidence: 0.9 };
    expect(sample.key).toBe('theme');
    expect(sample.confidence).toBe(0.9);
  });
});
