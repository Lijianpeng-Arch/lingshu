/**
 * 对话式技能创建状态机 (Phase W2.3)
 *
 * 借鉴 Open Interpreter ask-then-build 模式:
 *   idle → asking (4-5 步提问) → previewing (Live Preview) → saving → saved
 *
 * 每个 WizardSession 对应一次"做一个技能"的对话,用户回答 → 状态推进
 */

import { classifySkillType, type SkillLayer } from './skill-types.js';

export interface Question {
  id: string;
  prompt: string;
  suggestions?: string[];
}

export interface WizardPreview {
  id: string;
  displayName: string;
  displayDescription: string;
  triggers: string[];
  layer: SkillLayer;
  args?: Array<{ name: string; type: 'string' | 'number' | 'boolean'; required: boolean; description: string }>;
}

export type WizardPhase = 'asking' | 'previewing' | 'saving' | 'saved' | 'error';

export interface WizardSession {
  sessionId: string;
  phase: WizardPhase;
  subject: string;
  layer: SkillLayer;
  questions: Question[];
  currentIndex: number;
  answers: Record<string, string>;
  preview?: WizardPreview;
  savedPath?: string;
  error?: string;
}

let counter = 0;
function newId(): string {
  return `wizard-${Date.now()}-${++counter}`;
}

function buildQuestions(layer: SkillLayer): Question[] {
  const base: Question[] = [
    { id: 'displayName', prompt: '这个技能中文名叫什么？', suggestions: ['助手', '查询器', '小工具'] },
    { id: 'trigger', prompt: '用户说什么词会触发？', suggestions: ['查', '帮我', '打开'] },
    { id: 'description', prompt: '用一句话描述这个技能干啥？' },
  ];
  if (layer === 'api') {
    base.push({ id: 'apiSource', prompt: '数据从哪儿来？(API 名)', suggestions: ['高德天气', 'GitHub API', '聚合数据'] });
  } else if (layer === 'prompt') {
    base.push({ id: 'promptTemplate', prompt: '提示词模板大概内容？(可选)', suggestions: ['请帮我总结下面的内容', '请翻译成英文'] });
  }
  return base;
}

export function createWizard(input: { subject: string; layer?: SkillLayer }): WizardSession {
  const layer = input.layer ?? classifySkillType(input.subject).layer;
  return {
    sessionId: newId(),
    phase: 'asking',
    subject: input.subject,
    layer,
    questions: buildQuestions(layer),
    currentIndex: 0,
    answers: {},
  };
}

export function answerQuestion(session: WizardSession, questionId: string, answer: string): WizardSession {
  if (session.phase !== 'asking') return session;
  const newAnswers = { ...session.answers, [questionId]: answer };
  const nextIndex = session.currentIndex + 1;

  if (nextIndex >= session.questions.length) {
    // 所有问题答完 → 进入 previewing
    const preview = buildPreview(session, newAnswers);
    return { ...session, answers: newAnswers, currentIndex: nextIndex, phase: 'previewing', preview };
  }

  return { ...session, answers: newAnswers, currentIndex: nextIndex };
}

function buildPreview(session: WizardSession, answers: Record<string, string>): WizardPreview {
  const displayName = answers['displayName'] || `${session.subject}助手`;
  const trigger = answers['trigger'] || '帮我';
  const description = answers['description'] || `${session.subject}相关技能`;
  const id = `skill-${displayName.replace(/[^\w一-龥]/g, '-').toLowerCase()}`;

  const preview: WizardPreview = {
    id,
    displayName,
    displayDescription: description,
    triggers: [trigger, session.subject],
    layer: session.layer,
  };

  if (session.layer === 'api') {
    const apiSource = answers['apiSource'] || '通用 API';
    preview.displayDescription = `${description}（数据源: ${apiSource}）`;
  }

  return preview;
}

export function saveSkill(session: WizardSession): WizardSession {
  if (session.phase !== 'previewing' || !session.preview) {
    return { ...session, phase: 'error', error: 'cannot save: not in previewing phase' };
  }
  // 真实保存走 wizard.ts 的 API,这里只转 phase
  // 实际落地由调用方调 wizard.save(session)
  return { ...session, phase: 'saved' };
}

/**
 * Reserved for async save flow (e.g. wizard.save() with progress reporting).
 * Currently unreachable from saveSkill() which goes directly to 'saved'.
 * Keep for Phase W2.4 if wizard needs progress reporting.
 */
export function markSaved(session: WizardSession, path: string): WizardSession {
  if (session.phase !== 'saving') return session;
  return { ...session, phase: 'saved', savedPath: path };
}
