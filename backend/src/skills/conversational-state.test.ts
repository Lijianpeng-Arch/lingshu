/**
 * WizardSession 状态机测试 (Phase W2.3)
 */

import { describe, it, expect } from 'vitest';
import { createWizard, answerQuestion, saveSkill, markSaved, type WizardSession } from './conversational-state.js';

describe('WizardSession state machine', () => {
  it('createWizard returns session in asking phase with first question', () => {
    const session = createWizard({ subject: '天气查询', layer: 'api' });
    expect(session.phase).toBe('asking');
    expect(session.questions.length).toBeGreaterThan(0);
    expect(session.answers).toEqual({});
  });

  it('answerQuestion advances to next question', () => {
    let session = createWizard({ subject: '天气查询', layer: 'api' });
    const firstQ = session.questions[0];
    session = answerQuestion(session, firstQ.id, '天气助手');
    expect(session.answers[firstQ.id]).toBe('天气助手');
    expect(session.currentIndex).toBe(1);
  });

  it('answerQuestion all questions → phase becomes previewing', () => {
    let session = createWizard({ subject: '天气查询', layer: 'api' });
    for (const q of session.questions) {
      session = answerQuestion(session, q.id, `ans-${q.id}`);
    }
    expect(session.phase).toBe('previewing');
    expect(session.preview).toBeDefined();
    expect(session.preview?.displayName).toBeTruthy();
  });

  it('preview includes displayName, displayDescription, triggers', () => {
    let session = createWizard({ subject: '天气查询', layer: 'api' });
    session = answerQuestion(session, session.questions[0].id, '天气助手');
    session = answerQuestion(session, session.questions[1].id, '查天气');
    for (const q of session.questions.slice(2)) {
      session = answerQuestion(session, q.id, `ans-${q.id}`);
    }
    expect(session.phase).toBe('previewing');
    expect(session.preview?.displayName).toBe('天气助手');
    expect(session.preview?.triggers).toContain('查天气');
  });

  it('save transitions phase to saved', () => {
    let session = createWizard({ subject: '天气查询', layer: 'api' });
    for (const q of session.questions) {
      session = answerQuestion(session, q.id, `ans-${q.id}`);
    }
    session = saveSkill(session);
    expect(session.phase).toBe('saved');
  });

  it('markSaved transitions from saving to saved with path', () => {
    let session = createWizard({ subject: '天气查询', layer: 'api' });
    for (const q of session.questions) {
      session = answerQuestion(session, q.id, `ans-${q.id}`);
    }
    // Manually put session in 'saving' state (simulating async save flow)
    const savingSession = { ...session, phase: 'saving' as const };
    const saved = markSaved(savingSession, '/path/to/skill.json');
    expect(saved.phase).toBe('saved');
    expect(saved.savedPath).toBe('/path/to/skill.json');
  });
});
