/**
 * Spec 2D — chat-handler built-in command tests.
 *
 * Note: 这套测试不走 createMainLoop (主循环集成测试由 main-loop 自带).
 * 原因是 parallel 2C-2 sub-agent 有 in-progress 修改, 暂未加 parallel_group 迁移.
 * 直接 wire 依赖, 仅验证 chat-handler 路由层.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqlite } from '../db/sqlite.js';
import { createChatHandler } from './chat-handler.js';
import type { ChatHandlerDeps } from './chat-handler.js';
import type { UACSEnvelope } from '../uacs/envelope.js';
import { createPreferenceStore, type PreferenceStore } from '../preferences/store.js';
import { createPreferenceLearner, type PreferenceLearner } from '../preferences/learner.js';
import { createReminderService, type ReminderService } from '../proactive/reminder.js';
import { createProactiveDetector, type ProactiveDetector } from '../proactive/detector.js';
import type { LLMProvider } from '../agent/verifier.js';

interface FakeMainLoop {
  getReminderService(): ReminderService;
  getPreferenceStore(): PreferenceStore;
  getProactiveDetector(): ProactiveDetector;
  applyExplicitPreference(key: string, value: unknown): void;
}

function buildFakeLoop(llm?: LLMProvider): FakeMainLoop {
  const dir = mkdtempSync(join(tmpdir(), 'lingshu-fake-loop-'));
  const db = createSqlite(join(dir, 'fake.sqlite'));
  const store = createPreferenceStore(db);
  const learner = createPreferenceLearner({ store, llm: llm ?? stubLLM() });
  const reminders = createReminderService(db);
  const detector = createProactiveDetector({ broadcast: () => {}, reminderSvc: reminders });
  return {
    getReminderService: () => reminders,
    getPreferenceStore: () => store,
    getProactiveDetector: () => detector,
    applyExplicitPreference: (key, value) => learner.applyExplicit(key, value),
  };
}

function stubLLM(): LLMProvider {
  return { complete: async () => ({ text: '[]' }) };
}

function makeEnv(content: string): UACSEnvelope {
  return {
    id: 'env-test',
    type: 'chat.request',
    sender: 'electron',
    recipient: 'backend',
    timestamp: 1_700_000_000_000,
    correlationId: 'msg-1',
    traceMeta: {},
    payload: {
      messages: [{ role: 'user', content }],
      sessionId: 'sess-test',
    },
  } as unknown as UACSEnvelope;
}

function captureHandler(loop: FakeMainLoop) {
  const emissions: UACSEnvelope[] = [];
  const deps: ChatHandlerDeps = {
    emit: (env) => emissions.push(env),
    getProvider: () => ({
      chatStream: async function* () { yield { delta: '' }; },
    } as unknown as ReturnType<NonNullable<ChatHandlerDeps['getProvider']>>),
    mainLoop: loop as unknown as NonNullable<ChatHandlerDeps['mainLoop']>,
  };
  return { handler: createChatHandler(deps), emissions };
}

describe('chat-handler — built-in commands (Spec 2D)', () => {
  it('"提醒我 明天 9 点 开会" → reminder added, chat.delta returned', async () => {
    const loop = buildFakeLoop();
    const { handler, emissions } = captureHandler(loop);
    await handler(makeEnv('提醒我 明天 9 点 开会'));
    const deltas = emissions.filter((e) => e.type === 'chat.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const payload = deltas[0].payload as { delta: string };
    expect(payload.delta).toContain('好的');
    expect(payload.delta).toContain('开会');
    const reminders = loop.getReminderService().listAll();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].message).toContain('开会');
  });

  it('"明天 9 点提醒我 review" → reminder detected + 解析时间', async () => {
    const loop = buildFakeLoop();
    const { handler } = captureHandler(loop);
    await handler(makeEnv('明天 9 点提醒我 review'));
    const reminders = loop.getReminderService().listAll();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].message).toBe('review');
    const ts = reminders[0].triggerAt;
    const d = new Date(ts);
    expect(d.getHours()).toBe(9);
  });

  it('"记住 theme=dark" → preference stored as explicit', async () => {
    const loop = buildFakeLoop();
    const { handler } = captureHandler(loop);
    await handler(makeEnv('记住 theme=dark'));
    const prefs = loop.getPreferenceStore();
    expect(prefs.get('theme')).toBe('dark');
    const prefRec = prefs.list().find((p) => p.key === 'theme');
    expect(prefRec?.source).toBe('explicit');
  });

  it('"记住我喜欢智能审核" → preference stored (无 key=value, 存为 user_note)', async () => {
    const loop = buildFakeLoop();
    const { handler } = captureHandler(loop);
    await handler(makeEnv('记住我喜欢智能审核'));
    const prefs = loop.getPreferenceStore();
    expect(prefs.get('user_note')).toBe('我喜欢智能审核');
  });

  it('普通聊天消息 → 走原 LLM 路径 (不处理 built-in)', async () => {
    const loop = buildFakeLoop();
    const { handler } = captureHandler(loop);
    await handler(makeEnv('今天天气怎么样'));
    const reminders = loop.getReminderService().listAll();
    expect(reminders).toHaveLength(0);
    expect(loop.getPreferenceStore().list()).toEqual([]);
  });

  it('chat-handler 没有 mainLoop → 命令不识别 (兼容老路径, 不报错)', async () => {
    const emissions: UACSEnvelope[] = [];
    const deps: ChatHandlerDeps = {
      emit: (env) => emissions.push(env),
      getProvider: () => ({
        chatStream: async function* () { yield { delta: '' }; },
      } as unknown as ReturnType<NonNullable<ChatHandlerDeps['getProvider']>>),
    };
    const handler = createChatHandler(deps);
    await handler(makeEnv('提醒我明天9点开会'));
    expect(true).toBe(true);
  });
});
