/**
 * chat-handler 接对话式技能状态机测试 (Phase W2.4)
 *
 * 验证 chat-handler 在收到 "帮我做个 X 技能" 这类消息时:
 *   1. 识别 create_skill 意图
 *   2. 创建 WizardSession
 *   3. emit acui.show 卡片 (component: 'SkillWizardCard')
 *   4. 不走 LLM 流 (no chat.delta)
 *   5. 后续同一 sessionId 回答 → 推进 wizard → 再 emit acui.show
 *
 * 测试不依赖 wizard 完整端到端, 只验证 chat-handler 处的接线是否正确.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createChatHandler,
  _clearWizardSessionsForTest,
  _getWizardSessionForTest,
} from './chat-handler.js';
import type { UACSEnvelope, AcuiShowPayload } from '../uacs/envelope.js';
import type { Provider, ChatStreamChunk } from '../providers/types.js';

function makeReq(content: string, sessionId = 'sess-skill', correlationId = 'msg-skill'): UACSEnvelope {
  return {
    id: `env-${Date.now()}-${Math.random()}`,
    type: 'chat.request',
    sender: 'electron',
    recipient: 'backend',
    timestamp: Date.now(),
    correlationId,
    traceMeta: {},
    payload: { messages: [{ role: 'user', content }], sessionId },
  };
}

function fakeProvider(): Provider {
  return {
    name: 'fake',
    capabilities: ['chat'],
    canDo: () => true,
    chat: vi.fn(),
    chatStream: async function* (): AsyncIterable<ChatStreamChunk> {
      yield { delta: 'should-not-emit', done: false };
    },
    probe: vi.fn(),
  } as unknown as Provider;
}

describe('chat-handler skill creation integration (Phase W2.4)', () => {
  afterEach(() => {
    _clearWizardSessionsForTest();
  });

  it('"帮我做个天气技能" → 触发 create_skill 意图 + 创建 wizard + emit acui.show', async () => {
    const provider = fakeProvider();
    const emitted: UACSEnvelope[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
    });
    await handler(makeReq('帮我做个天气技能'));

    // 1. 必然 emit acui.show
    const acuiShows = emitted.filter((e) => e.type === 'acui.show');
    expect(acuiShows).toHaveLength(1);

    // 2. component 是 SkillWizardCard, props 携带 sessionId + currentQuestion
    const payload = acuiShows[0].payload as AcuiShowPayload;
    expect(payload.component).toBe('SkillWizardCard');
    expect(payload.props).toBeDefined();
    expect(payload.props.sessionId).toBeTruthy();
    expect(typeof payload.props.sessionId).toBe('string');
    expect(payload.props.currentQuestion).toBeDefined();
    const cq = payload.props.currentQuestion as { id: string; prompt: string };
    expect(typeof cq.id).toBe('string');
    expect(typeof cq.prompt).toBe('string');

    // 3. 没走 LLM 流 (no chat.delta)
    expect(emitted.filter((e) => e.type === 'chat.delta')).toHaveLength(0);

    // 4. emit chat.done 清掉 sending 状态
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('相同 chat sessionId 后续消息 → 推进 wizard → 再 emit acui.show (下一题)', async () => {
    const provider = fakeProvider();
    const emitted: UACSEnvelope[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
    });

    // 第一轮: 触发创建
    await handler(makeReq('帮我做个天气技能', 'sess-multi', 'm1'));
    const firstShow = emitted.find((e) => e.type === 'acui.show');
    expect(firstShow).toBeDefined();
    const firstProps = firstShow!.payload as AcuiShowPayload;
    const wizardSessionId = firstProps.props.sessionId as string;
    const firstQuestionId = (firstProps.props.currentQuestion as { id: string }).id;

    emitted.length = 0;

    // 第二轮: 用户回答第一题
    await handler(makeReq('天气助手', 'sess-multi', 'm2'));
    const secondShow = emitted.find((e) => e.type === 'acui.show');
    expect(secondShow).toBeDefined();
    const secondProps = secondShow!.payload as AcuiShowPayload;
    // 同一个 wizard session
    expect(secondProps.props.sessionId).toBe(wizardSessionId);
    // currentQuestion 推进到下一题 (id 不同)
    const secondQuestionId = (secondProps.props.currentQuestion as { id: string }).id;
    expect(secondQuestionId).not.toBe(firstQuestionId);

    // 还是没走 LLM 流
    expect(emitted.filter((e) => e.type === 'chat.delta')).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('非技能创建消息 → 不触发 wizard, 走 LLM 流', async () => {
    const provider = fakeProvider();
    const emitted: UACSEnvelope[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
    });
    await handler(makeReq('你好呀'));
    expect(emitted.filter((e) => e.type === 'acui.show')).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'chat.delta')).toHaveLength(1);
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('previewing → save: 答完所有问题后再发消息 → 调 saveSkill + emit acui.hide 关闭卡片', async () => {
    const provider = fakeProvider();
    const emitted: UACSEnvelope[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
    });

    // 1) 触发创建 ("天气" → api 层 → 4 题: displayName / trigger / description / apiSource)
    await handler(makeReq('帮我做个天气技能', 'sess-save', 's0'));
    const firstShow = emitted.find((e) => e.type === 'acui.show')!;
    const wizardSessionId = (firstShow.payload as AcuiShowPayload).props.sessionId as string;

    // 2) 逐题回答, 直到 wizard 进入 previewing 阶段.
    //    每答一题都应还在 asking, 发 acui.show; 答完最后一题后 chat-handler 仍 emit
    //    acui.show(previewing 卡). 用 _getWizardSessionForTest 观察 phase 收敛.
    const answers = ['天气助手', '查天气', '查询实时天气', '高德天气'];
    for (let i = 0; i < answers.length; i++) {
      emitted.length = 0;
      await handler(makeReq(answers[i], 'sess-save', `s${i + 1}`));
      // 每一轮都走 wizard, 不走 LLM
      expect(emitted.filter((e) => e.type === 'chat.delta')).toHaveLength(0);
      expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
    }

    // 答完 4 题 → wizard 应在 previewing 阶段
    const previewing = _getWizardSessionForTest(wizardSessionId)!;
    expect(previewing).toBeDefined();
    expect(previewing.phase).toBe('previewing');
    expect(previewing.preview).toBeDefined();

    // 3) previewing 状态下再发一条消息 → 当作 "保存" 确认.
    emitted.length = 0;
    await handler(makeReq('保存', 'sess-save', 's-save'));

    // saveSkill 被调用 → wizard 切到 saved
    const saved = _getWizardSessionForTest(wizardSessionId)!;
    expect(saved.phase).toBe('saved');

    // emit acui.hide 关闭 SkillWizardCard, 不 emit acui.show, 不走 LLM
    const hides = emitted.filter((e) => e.type === 'acui.hide');
    expect(hides).toHaveLength(1);
    expect((hides[0].payload as { componentId: string }).componentId).toBe('SkillWizardCard');
    expect(emitted.filter((e) => e.type === 'acui.show')).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'chat.delta')).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('saved 后孤儿清理: wizard 到 saved 阶段后再发消息 → 清理 mapping 且不再触发 wizard, 走 LLM 流', async () => {
    const provider = fakeProvider();
    const emitted: UACSEnvelope[] = [];
    const handler = createChatHandler({
      emit: (env) => emitted.push(env),
      getProvider: () => provider,
      timeoutMs: 1000,
      now: () => 12345,
    });

    // 1) 建 wizard 并答满 4 题到 previewing, 再 "保存" 切到 saved
    await handler(makeReq('帮我做个天气技能', 'sess-orphan', 'o0'));
    const firstShow = emitted.find((e) => e.type === 'acui.show')!;
    const wizardSessionId = (firstShow.payload as AcuiShowPayload).props.sessionId as string;

    const answers = ['天气助手', '查天气', '查询实时天气', '高德天气'];
    for (let i = 0; i < answers.length; i++) {
      await handler(makeReq(answers[i], 'sess-orphan', `o${i + 1}`));
    }
    await handler(makeReq('保存', 'sess-orphan', 'o-save'));
    // 到此 wizard 已 saved, chat→wizard mapping 已在 save 路径删除
    expect(_getWizardSessionForTest(wizardSessionId)!.phase).toBe('saved');

    // 2) 同 chat sessionId 再发一条普通消息 → 不得再触发 wizard, 应走 LLM 流
    emitted.length = 0;
    await handler(makeReq('今天几号', 'sess-orphan', 'o-next'));

    // 不重新弹卡片, 不再 hide, 走 LLM
    expect(emitted.filter((e) => e.type === 'acui.show')).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'acui.hide')).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'chat.delta')).toHaveLength(1);
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });
});
