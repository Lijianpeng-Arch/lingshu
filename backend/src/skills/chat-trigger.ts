/**
 * 对话式技能 chat 触发 (Phase W2.4 — chat 触发)
 *
 * 把 chat-handler 内嵌的 wizard 控制流剥离出来, 形成一个独立可测的 ChatTrigger:
 *   maybeEnterWizard(userMsg, chatSessionId) → 检测 create_skill 意图, 启动 wizard, 提问
 *   onAnswer(wizardSessionId, questionId, answer) → 推进状态机, 答完 → previewing
 *   cancelWizard(wizardSessionId) → 清理 session
 *
 * 复用 conversational-state 的 WizardSession / answerQuestion / saveSkill (只读).
 * 生成的问题覆盖到 session.questions (LLM 生成 4-5 题, 失败 fallback 静态).
 *
 * chat-handler 在主对话流**最前面**调用 maybeEnterWizard;
 * 后续同一 chatSessionId 的消息用作 wizard 答案.
 */

import type { UACSEnvelope, AcuiShowPayload, AcuiHidePayload } from '../uacs/envelope.js';
import type { LLMProvider } from '../agent/verifier.js';
import { detectSkillCreationIntent } from './intents.js';
import {
  createWizard,
  answerQuestion,
  saveSkill,
  type WizardSession,
  type Question,
  type WizardPreview,
} from './conversational-state.js';
import { generateQuestions, STATIC_FALLBACK } from './llm-questions.js';
import { buildPreview } from './preview-builder.js';

export interface ChatTriggerDeps {
  llm?: LLMProvider;
  /** emit ACUI 卡片 / 关闭卡片 */
  emit: (env: UACSEnvelope) => void;
  /** 调用 saveSkill API (复用 routes.ts: POST /api/skills) — 落盘 */
  saveSkill: (preview: WizardPreview) => Promise<{ path: string }>;
  /** 测试钩子 — 需要从外部查 session */
  getSession?: (wizardSessionId: string) => WizardSession | undefined;
  setSession?: (wizardSessionId: string, session: WizardSession) => void;
  /** 自定义 now() for 测试 */
  now?: () => number;
}

export interface ChatTrigger {
  /** 检测用户消息是否要创建技能, 是则启动 wizard 并 emit 第一题 */
  maybeEnterWizard(
    userMsg: string,
    chatSessionId: string,
    env: UACSEnvelope,
  ): Promise<WizardSession | null>;
  /** 用户回答了一题, 推进状态机. 答完切到 previewing emit 预览卡; 不再答的"保存"消息保存 + 关闭卡 */
  onAnswer(
    wizardSessionId: string,
    questionId: string,
    answer: string,
    env: UACSEnvelope,
    chatSessionId?: string,
  ): Promise<{ session: WizardSession; action: 'continue' | 'previewing' | 'saved' | 'noop' }>;
  /** 用户取消 / 跳过 / 清理 */
  cancelWizard(wizardSessionId: string): void;
  /** 测试钩子 — 全部清空 */
  _resetForTest(): void;
}

// ━━ ACUI 卡片转换 ────────────────────────────────────────────────────
// 提取出来便于测试和复用. asking 阶段 → currentQuestion;
// previewing 阶段 → preview.
function buildAcuiPropsFromWizard(session: WizardSession): Record<string, unknown> {
  const base = { sessionId: session.sessionId };
  if (session.phase === 'asking') {
    return {
      ...base,
      phase: 'asking',
      currentQuestion: session.questions[session.currentIndex],
      progress: { current: session.currentIndex + 1, total: session.questions.length },
      subject: session.subject,
      layer: session.layer,
    };
  }
  if (session.phase === 'previewing' && session.preview) {
    return {
      ...base,
      phase: 'previewing',
      preview: session.preview,
      subject: session.subject,
      layer: session.layer,
    };
  }
  return base;
}

function emitAcuiShow(
  trigger: ChatTriggerDeps,
  env: UACSEnvelope,
  session: WizardSession,
): void {
  const props = buildAcuiPropsFromWizard(session);
  const payload: AcuiShowPayload = { component: 'SkillWizardCard', props };
  trigger.emit({ ...env, type: 'acui.show', payload });
}

function emitAcuiHide(
  trigger: ChatTriggerDeps,
  env: UACSEnvelope,
  componentId = 'SkillWizardCard',
): void {
  const payload: AcuiHidePayload = { componentId };
  trigger.emit({ ...env, type: 'acui.hide', payload });
}

// ━━ 模块级 session store ─────────────────────────────────────────────
// In-memory. chat-handler 进程级别共享. Tests 清 via _resetForTest.
const sessions = new Map<string, WizardSession>();
const byChatSession = new Map<string, string>();

/**
 * 核心工厂. 返回 ChatTrigger instance, 持有 deps.
 */
export function createChatTrigger(deps: ChatTriggerDeps): ChatTrigger {
  // 把 deps 的 getSession/setSession 适配到 module-level sessions map.
  // 这样外部 chat-handler 可以直接读 session, 测试也能 mock.
  const getSession = (id: string): WizardSession | undefined => {
    if (deps.getSession) return deps.getSession(id);
    return sessions.get(id);
  };
  const setSession = (id: string, s: WizardSession): void => {
    if (deps.setSession) {
      deps.setSession(id, s);
      return;
    }
    sessions.set(id, s);
  };
  const deleteSession = (id: string): void => {
    sessions.delete(id);
    // 反向: 删除所有 chat→wizard mapping 指向这个 wizard
    for (const [chat, wizard] of byChatSession.entries()) {
      if (wizard === id) byChatSession.delete(chat);
    }
  };

  /**
   * 1) 同一 chatSession 已有 active wizard → 不触发新 (caller 应走 onAnswer 路径)
   * 2) 没 wizard, 检测 create_skill 意图
   * 3) 都不命中 → null (caller 走原 chat 流)
   */
  const trigger: ChatTrigger = {
    async maybeEnterWizard(userMsg, chatSessionId, env): Promise<WizardSession | null> {
      // 已经有 active wizard → 不创建新, 让 caller 走 onAnswer 路径
      if (byChatSession.has(chatSessionId)) {
        return null;
      }
      const intent = detectSkillCreationIntent(userMsg);
      if (intent.intent !== 'create_skill' || !intent.subject) return null;

      // 创建 wizard — 用 LLM 生成问题, 失败回 fallback
      const session = createWizard({ subject: intent.subject });
      const llmQs: Question[] = (await generateQuestions(intent.subject, deps.llm)).map((q) => ({
        id: q.id,
        prompt: q.prompt,
        suggestions: q.suggestions,
      }));
      // 若 LLM 返回 empty, fallback 用 STATIC_FALLBACK
      if (llmQs.length === 0) {
        session.questions = STATIC_FALLBACK.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          suggestions: q.suggestions,
        }));
      } else {
        session.questions = llmQs;
      }
      // 确保有 displayName + trigger + description 三个核心字段 (兜底补齐)
      const required: Array<{ id: string; prompt: string }> = [
        { id: 'displayName', prompt: '这个技能中文名叫什么？' },
        { id: 'trigger', prompt: '用户说什么词会触发？' },
        { id: 'description', prompt: '用一句话描述这个技能干啥？' },
      ];
      for (const req of required) {
        if (!session.questions.some((q) => q.id === req.id)) {
          session.questions.push(req);
        }
      }

      setSession(session.sessionId, session);
      byChatSession.set(chatSessionId, session.sessionId);
      emitAcuiShow(deps, env, session);
      return session;
    },

    async onAnswer(wizardSessionId, questionId, answer, env, chatSessionId) {
      const session = getSession(wizardSessionId);
      if (!session) return { session: {} as WizardSession, action: 'noop' };

      if (session.phase === 'asking') {
        const advanced = answerQuestion(session, questionId, answer);
        setSession(wizardSessionId, advanced);

        // 答完所有题 → 走 preview-builder 生成完整预览 (含 trigger 候选 + test cases)
        if (advanced.phase === 'previewing') {
          const prevData = await buildPreview(
            advanced.answers,
            advanced.subject,
            advanced.layer,
            deps.llm,
          );
          const enrichedPreview: WizardPreview = {
            ...(advanced.preview ?? prevData.preview),
            ...prevData.preview,
            triggers: Array.from(
              new Set([
                ...(advanced.preview?.triggers ?? []),
                ...prevData.triggerSuggestions,
              ]),
            ),
          };
          const enriched: WizardSession = { ...advanced, preview: enrichedPreview };
          setSession(wizardSessionId, enriched);
          emitAcuiShow(deps, env, enriched);
          return { session: enriched, action: 'previewing' };
        }

        // 还在 asking, 发下一题
        emitAcuiShow(deps, env, advanced);
        return { session: advanced, action: 'continue' };
      }

      if (session.phase === 'previewing') {
        // 用户在 preview 阶段再发消息 → 当 "保存" 确认
        const saved = saveSkill(session);
        if (saved.preview) {
          try {
            const result = await deps.saveSkill(saved.preview);
            if (result?.path) {
              saved.savedPath = result.path;
            }
          } catch (err) {
            console.error('[chat-trigger] saveSkill failed:', err);
          }
        }
        setSession(wizardSessionId, saved);
        emitAcuiHide(deps, env);
        // 清理 chat→wizard mapping 让同 chat session 后续消息回到主 chat 流
        if (chatSessionId) {
          for (const [chat, wizard] of byChatSession.entries()) {
            if (wizard === wizardSessionId) byChatSession.delete(chat);
          }
        }
        // 保留 saved session 供后续 `_getWizardSessionForTest().phase === 'saved'` 观察
        return { session: saved, action: 'saved' };
      }

      // saved / error → noop, 让 caller 走原 chat 流
      return { session, action: 'noop' };
    },

    cancelWizard(wizardSessionId) {
      const session = getSession(wizardSessionId);
      if (!session) return;
      deleteSession(wizardSessionId);
    },

    _resetForTest() {
      sessions.clear();
      byChatSession.clear();
    },
  };

  return trigger;
}

/**
 * 测试钩子: 不通过 instance 直接查 module-level session store
 */
export function _getWizardSessionForTest(
  wizardSessionId: string,
): WizardSession | undefined {
  return sessions.get(wizardSessionId);
}

/**
 * 测试钩子: 清空 module-level session store
 */
export function _clearWizardSessionsForTest(): void {
  sessions.clear();
  byChatSession.clear();
}

/**
 * 测试钩子: 查 chatSessionId → wizardSessionId 映射
 */
export function _getWizardByChatSessionForTest(
  chatSessionId: string,
): WizardSession | undefined {
  const id = byChatSession.get(chatSessionId);
  if (!id) return undefined;
  return sessions.get(id);
}
