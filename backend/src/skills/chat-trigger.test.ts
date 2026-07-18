/**
 * ChatTrigger 测试 (Phase W2.4 — 对话式技能 chat 触发)
 *
 * 覆盖:
 *   - 意图检测 + wizard 创建
 *   - 4-5 题 onboarding (LLM 模式 + 静态 fallback 模式)
 *   - onAnswer 推进状态机, 答满 → previewing
 *   - previewing → save 走真正 saveSkill API
 *   - cancel / 孤儿清理
 *   - ACUI 卡片 emit 次数与 payload 形状
 *   - LLM 抛错 / 无 LLM → fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createChatTrigger,
  _clearWizardSessionsForTest,
  _getWizardSessionForTest,
  _getWizardByChatSessionForTest,
} from './chat-trigger.js';
import { generateQuestions, STATIC_FALLBACK } from './llm-questions.js';
import { buildPreview, buildPreviewSync } from './preview-builder.js';
import type { UACSEnvelope, AcuiShowPayload, AcuiHidePayload } from '../uacs/envelope.js';
import type { LLMProvider } from '../agent/verifier.js';

function makeEnv(): UACSEnvelope {
  return {
    id: 'env-test',
    type: 'chat.request',
    sender: 'electron',
    recipient: 'backend',
    timestamp: 1000,
    correlationId: 'msg-1',
    traceMeta: {},
    payload: { messages: [], sessionId: 'sess-x' },
  };
}

function collectEmits(): { emit: (env: UACSEnvelope) => void; list: UACSEnvelope[] } {
  const list: UACSEnvelope[] = [];
  return {
    list,
    emit: (env) => list.push(env),
  };
}

function fakeLlm(overrides?: { jsonResponse?: string; throwError?: boolean }): LLMProvider {
  return {
    complete: vi.fn(async (req: { prompt: string; json?: boolean }) => {
      if (overrides?.throwError) throw new Error('LLM unreachable');
      return { text: overrides?.jsonResponse ?? '' };
    }),
  };
}

describe('generateQuestions (llm-questions.ts)', () => {
  it('no LLM → 返回 5 题静态 fallback', async () => {
    const qs = await generateQuestions('天气', undefined);
    expect(qs).toHaveLength(STATIC_FALLBACK.length);
    expect(qs.every((q) => typeof q.id === 'string' && typeof q.prompt === 'string')).toBe(true);
    expect(qs.find((q) => q.id === 'displayName')).toBeDefined();
  });

  it('LLM 返回合规 JSON → 用 LLM 版本', async () => {
    const llmJson = JSON.stringify({
      questions: [
        { id: 'q1', prompt: '第一个问题', type: 'text' },
        { id: 'q2', prompt: '第二个问题', type: 'confirm' },
        { id: 'q3', prompt: '第三个问题', type: 'select', options: ['A', 'B'] },
        { id: 'q4', prompt: '第四个问题', type: 'text', suggestions: ['a', 'b'] },
      ],
    });
    const qs = await generateQuestions('天气', fakeLlm({ jsonResponse: llmJson }));
    expect(qs).toHaveLength(4);
    expect(qs[0].id).toBe('q1');
    expect(qs[2].options).toEqual(['A', 'B']);
    expect(qs[3].suggestions).toEqual(['a', 'b']);
  });

  it('LLM 返回 markdown json 块也能解析', async () => {
    const llm = fakeLlm({
      jsonResponse: '以下是问题:\n```json\n{"questions":[{"id":"q1","prompt":"A","type":"text"},{"id":"q2","prompt":"B","type":"text"},{"id":"q3","prompt":"C","type":"text"}]}\n```',
    });
    const qs = await generateQuestions('天气', llm);
    expect(qs.length).toBeGreaterThanOrEqual(3);
    expect(qs[0].id).toBe('q1');
  });

  it('LLM 抛错 → fallback 5 题, 不挂', async () => {
    const qs = await generateQuestions('天气', fakeLlm({ throwError: true }));
    expect(qs).toHaveLength(STATIC_FALLBACK.length);
    expect(qs[0].id).toBe('displayName');
  });

  it('LLM 返回空对象 → fallback', async () => {
    const qs = await generateQuestions('天气', fakeLlm({ jsonResponse: '{}' }));
    expect(qs).toHaveLength(STATIC_FALLBACK.length);
  });

  it('LLM 返回 0 题 → fallback', async () => {
    const qs = await generateQuestions('天气', fakeLlm({ jsonResponse: '{"questions":[]}' }));
    expect(qs).toHaveLength(STATIC_FALLBACK.length);
  });

  it('LLM 返回 >5 题 → 截到 5', async () => {
    const llmJson = JSON.stringify({
      questions: Array.from({ length: 8 }).map((_, i) => ({
        id: `q${i}`,
        prompt: `Q${i}`,
        type: 'text',
      })),
    });
    const qs = await generateQuestions('天气', fakeLlm({ jsonResponse: llmJson }));
    expect(qs.length).toBeLessThanOrEqual(5);
  });
});

describe('buildPreview (preview-builder.ts)', () => {
  it('buildPreviewSync: 不调 LLM, 返回本地预览', () => {
    const data = buildPreviewSync(
      { displayName: '天气助手', trigger: '查天气', description: '查询实时天气' },
      '天气',
    );
    expect(data.preview.displayName).toBe('天气助手');
    expect(data.preview.triggers).toContain('查天气');
    expect(data.triggerSuggestions.length).toBeGreaterThan(0);
    expect(data.testCases.length).toBeGreaterThan(0);
  });

  it('buildPreview 异步: LLM 给的 trigger suggestions 合并入 wizard preview', async () => {
    const llmJson = JSON.stringify(['查', '帮我查', '天气查询']);
    const llm = fakeLlm({ jsonResponse: llmJson });
    const data = await buildPreview(
      { displayName: '天气助手', trigger: '查天气', description: '查询实时天气' },
      '天气',
      'api',
      llm,
    );
    expect(data.preview.displayName).toBe('天气助手');
    expect(data.preview.triggers.length).toBeGreaterThan(1);
    expect(data.preview.triggers).toContain('查天气');
  });

  it('buildPreview LLM 抛错 → 用本地 fallback, 不挂', async () => {
    const data = await buildPreview(
      { displayName: 'X', trigger: 'tx', description: 'd' },
      'X 主题',
      'prompt',
      fakeLlm({ throwError: true }),
    );
    expect(data.preview.displayName).toBe('X');
    expect(data.triggerSuggestions.length).toBeGreaterThan(0);
  });
});

describe('createChatTrigger', () => {
  beforeEach(() => {
    _clearWizardSessionsForTest();
  });
  afterEach(() => {
    _clearWizardSessionsForTest();
  });

  it('"帮我做个天气技能" → 创建 WizardSession + emit acui.show', async () => {
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({
      emit,
      saveSkill: async () => ({ path: '/skills/wx.json' }),
    });
    const env = makeEnv();
    const session = await trigger.maybeEnterWizard('帮我做个天气技能', 'sess-1', env);

    expect(session).not.toBeNull();
    expect(session!.phase).toBe('asking');
    expect(session!.subject).toContain('天气');
    expect(list.some((e) => e.type === 'acui.show')).toBe(true);
    const show = list.find((e) => e.type === 'acui.show')!;
    const payload = show.payload as AcuiShowPayload;
    expect(payload.component).toBe('SkillWizardCard');
    expect((payload.props as { sessionId: unknown }).sessionId).toBe(session!.sessionId);
  });

  it('"今天天气怎样" (非创建) → maybeEnterWizard 返回 null, 不 emit 卡片', async () => {
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({
      emit,
      saveSkill: async () => ({ path: '/x.json' }),
    });
    const session = await trigger.maybeEnterWizard('今天天气怎样', 'sess-no', makeEnv());
    expect(session).toBeNull();
    expect(list.filter((e) => e.type === 'acui.show')).toHaveLength(0);
  });

  it('问题覆盖核心字段: displayName + trigger + description 必在', async () => {
    const llmJson = JSON.stringify({
      questions: [
        { id: 'custom-q', prompt: '主题特定问题', type: 'text' },
      ],
    });
    const llm = fakeLlm({ jsonResponse: llmJson });
    const trigger = createChatTrigger({
      emit: collectEmits().emit,
      saveSkill: async () => ({ path: '/x.json' }),
      llm,
    });
    const session = await trigger.maybeEnterWizard('帮我做个查询股票技能', 'sess-cov', makeEnv());
    expect(session).not.toBeNull();
    const ids = session!.questions.map((q) => q.id);
    expect(ids).toContain('displayName');
    expect(ids).toContain('trigger');
    expect(ids).toContain('description');
  });

  it('onAnswer 推进 wizard, emit 下一题 acui.show', async () => {
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({ emit, saveSkill: async () => ({ path: '/x' }) });
    const env = makeEnv();
    const session = await trigger.maybeEnterWizard('做个天气技能', 'sess-on', env);
    expect(session).not.toBeNull();

    list.length = 0;
    const result = await trigger.onAnswer(session!.sessionId, session!.questions[0].id, '天气助手', env);
    expect(result.action).toBe('continue');
    expect(result.session.answers[session!.questions[0].id]).toBe('天气助手');

    const show = list.find((e) => e.type === 'acui.show')!;
    const props = (show.payload as AcuiShowPayload).props as {
      currentQuestion: { id: string };
    };
    expect(props.currentQuestion.id).not.toBe(session!.questions[0].id);
  });

  it('onAnswer 答完所有题 → action=previewing + emit 含 preview 卡', async () => {
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({ emit, saveSkill: async () => ({ path: '/skills/weather.json' }) });
    const env = makeEnv();
    const session = await trigger.maybeEnterWizard('做个天气技能', 'sess-full', env);
    expect(session).not.toBeNull();

    let cur = session!;
    list.length = 0;
    for (const q of cur.questions) {
      const r = await trigger.onAnswer(cur.sessionId, q.id, `ans-${q.id}`, env);
      cur = r.session;
    }
    expect(cur.phase).toBe('previewing');
    expect(cur.preview).toBeDefined();
    expect(cur.preview!.displayName).toBeTruthy();

    const show = [...list].reverse().find((e) => e.type === 'acui.show')!;
    const props = (show.payload as AcuiShowPayload).props as { phase: string; preview: unknown };
    expect(props.phase).toBe('previewing');
    expect(props.preview).toBeDefined();
  });

  it('previewing 后续消息 → 调 saveSkill API + emit acui.hide', async () => {
    const savedPaths: string[] = [];
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({
      emit,
      saveSkill: async (preview) => {
        savedPaths.push(`/saved/${preview.id}.json`);
        return { path: `/saved/${preview.id}.json` };
      },
    });
    const env = makeEnv();
    const session = await trigger.maybeEnterWizard('做个天气技能', 'sess-sv', env);
    let cur = session!;
    for (const q of cur.questions) {
      const r = await trigger.onAnswer(cur.sessionId, q.id, `ans-${q.id}`, env);
      cur = r.session;
    }
    expect(cur.phase).toBe('previewing');

    list.length = 0;
    const saveResult = await trigger.onAnswer(cur.sessionId, 'anything', '保存', env);
    expect(saveResult.action).toBe('saved');
    expect(saveResult.session.phase).toBe('saved');
    expect(savedPaths.length).toBe(1);
    expect(savedPaths[0]).toMatch(/skill-/);

    const hides = list.filter((e) => e.type === 'acui.hide');
    expect(hides).toHaveLength(1);
    expect((hides[0].payload as AcuiHidePayload).componentId).toBe('SkillWizardCard');
  });

  it('previewing 阶段 saveSkill 抛错 → 仍切到 saved 阶段, 不挂', async () => {
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({
      emit,
      saveSkill: async () => {
        throw new Error('disk full');
      },
    });
    const env = makeEnv();
    const session = await trigger.maybeEnterWizard('做个股票技能', 'sess-err', env);
    let cur = session!;
    for (const q of cur.questions) {
      const r = await trigger.onAnswer(cur.sessionId, q.id, 'a', env);
      cur = r.session;
    }
    list.length = 0;
    const r = await trigger.onAnswer(cur.sessionId, 'x', '保存', env);
    expect(r.action).toBe('saved');
    expect(r.session.phase).toBe('saved');
  });

  it('cancelWizard → 删除 session, 后续同 id noop', async () => {
    const { emit } = collectEmits();
    const trigger = createChatTrigger({ emit, saveSkill: async () => ({ path: '/x' }) });
    const env = makeEnv();
    const session = await trigger.maybeEnterWizard('帮我做个 x 技能', 'sess-cancel', env);
    expect(session).not.toBeNull();

    trigger.cancelWizard(session!.sessionId);
    expect(_getWizardSessionForTest(session!.sessionId)).toBeUndefined();
    expect(_getWizardByChatSessionForTest('sess-cancel')).toBeUndefined();

    // 取消后 onAnswer 应 noop
    const r = await trigger.onAnswer(session!.sessionId, 'displayName', 'X', env);
    expect(r.action).toBe('noop');
  });

  it('"帮我做个 X 技能" 多次同 chatSession → 第二次 maybeEnterWizard 返回 null (已有 wizard)', async () => {
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({ emit, saveSkill: async () => ({ path: '/x' }) });
    const env = makeEnv();
    const first = await trigger.maybeEnterWizard('帮我做个天气技能', 'sess-multi', env);
    expect(first).not.toBeNull();

    list.length = 0;
    const second = await trigger.maybeEnterWizard('帮我做一个别的技能', 'sess-multi', env);
    expect(second).toBeNull();
    // 没有再 emit 新卡
    expect(list.filter((e) => e.type === 'acui.show')).toHaveLength(0);
  });

  it('空消息 / 纯语气 → 不会被识别为创建', async () => {
    const { emit } = collectEmits();
    const trigger = createChatTrigger({ emit, saveSkill: async () => ({ path: '/x' }) });
    const r1 = await trigger.maybeEnterWizard('', 'sess-empty', makeEnv());
    expect(r1).toBeNull();
    const r2 = await trigger.maybeEnterWizard('做个技能', 'sess-vague', makeEnv());
    // "做个技能" 兜底匹配 → 仍算意图 (intents.ts 设计如此)
    expect(r2).not.toBeNull();
    expect(r2!.subject).toBe('未指定');
  });

  it('onAnswer 在 saved 阶段 → noop', async () => {
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({
      emit,
      saveSkill: async () => ({ path: '/x.json' }),
    });
    const env = makeEnv();
    const session = await trigger.maybeEnterWizard('帮我做个天气技能', 'sess-saved', env);
    let cur = session!;
    for (const q of cur.questions) {
      const r = await trigger.onAnswer(cur.sessionId, q.id, 'a', env);
      cur = r.session;
    }
    await trigger.onAnswer(cur.sessionId, 'x', '保存', env);
    list.length = 0;
    const r = await trigger.onAnswer(cur.sessionId, 'y', '再见', env);
    expect(r.action).toBe('noop');
    expect(list.filter((e) => e.type === 'acui.show' || e.type === 'acui.hide')).toHaveLength(0);
  });

  it('LLM 抛错时整个 round-trip 仍能跑通: 启动 → 答完 → save', async () => {
    const { emit, list } = collectEmits();
    const trigger = createChatTrigger({
      emit,
      llm: fakeLlm({ throwError: true }),
      saveSkill: async (preview) => ({ path: `/saved/${preview.id}.json` }),
    });
    const env = makeEnv();
    const session = await trigger.maybeEnterWizard('帮我做个天气技能', 'sess-round', env);
    expect(session).not.toBeNull();
    // 应当 fallback 到 5 题
    expect(session!.questions.length).toBeGreaterThanOrEqual(3);

    let cur = session!;
    for (const q of cur.questions) {
      const r = await trigger.onAnswer(cur.sessionId, q.id, 'a', env);
      cur = r.session;
    }
    expect(cur.phase).toBe('previewing');

    list.length = 0;
    const final = await trigger.onAnswer(cur.sessionId, 'x', '保存', env);
    expect(final.action).toBe('saved');
    expect(list.some((e) => e.type === 'acui.hide')).toBe(true);
  });

  it('created wizard 不破坏: sessionId 是 wizard- 前缀, chat→wizard 映射正确', async () => {
    const { emit } = collectEmits();
    const trigger = createChatTrigger({ emit, saveSkill: async () => ({ path: '/x' }) });
    const session = await trigger.maybeEnterWizard('帮我做个天气技能', 'sess-id', makeEnv());
    expect(session!.sessionId).toMatch(/^wizard-/);
    const mapped = _getWizardByChatSessionForTest('sess-id');
    expect(mapped?.sessionId).toBe(session!.sessionId);
  });
});
