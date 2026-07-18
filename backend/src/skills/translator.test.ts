import { describe, it, expect, vi } from 'vitest';
import { translateSkill, SkillTranslationError } from './translator.js';

// Mock helper: provider.chatStream 返回 AsyncIterable<{ delta?: string }>
async function* mockChatStream(chunks: string[]) {
  for (const c of chunks) yield { delta: c };
}

describe('translateSkill', () => {
  it('full chinese skill: 不调 LLM,直接返回,保留原字段', async () => {
    const provider = { chatStream: vi.fn() } as any;
    const skill = { name: 'weather', displayName: '天气', description: '查天气', version: '1.0.0', lingshuMinVersion: '2.0.0' };
    const out = await translateSkill(skill, provider);
    expect(out.displayName).toBe('天气');
    expect(out.description).toBe('查天气');
    expect(out.name).toBe('weather');
    expect(out.version).toBe('1.0.0');
    expect(provider.chatStream).not.toHaveBeenCalled();
  });

  it('缺中文时调 LLM 翻译,保留 name/version 字段', async () => {
    const provider = {
      chatStream: vi.fn().mockReturnValue(mockChatStream(['天气查询|查指定城市的天气'])),
    } as any;
    const out = await translateSkill(
      { name: 'weather', displayName: '', description: 'lookup city weather', version: '1.0.0', lingshuMinVersion: '2.0.0' },
      provider
    );
    expect(out.displayName).toBe('天气查询');
    expect(out.description).toBe('查指定城市的天气');
    expect(out.name).toBe('weather');
    expect(out.version).toBe('1.0.0');
  });

  it('第三方草稿(无 version/lingshuMinVersion)也能被翻译', async () => {
    const provider = {
      chatStream: vi.fn().mockReturnValue(mockChatStream(['天气查询|查天气'])),
    } as any;
    const out = await translateSkill(
      { name: 'weather', description: 'lookup city weather' },
      provider
    );
    expect(out.displayName).toBe('天气查询');
    expect(out.description).toBe('查天气');
    expect(out.name).toBe('weather');
  });

  it('LLM 翻译失败抛 SkillTranslationError', async () => {
    const provider = {
      chatStream: vi.fn().mockImplementation(() => {
        throw new Error('quota');
      }),
    } as any;
    await expect(translateSkill(
      { name: 'x', displayName: '', description: 'foo bar' },
      provider
    )).rejects.toThrow(SkillTranslationError);
  });

  it('LLM 返回空字符串抛错', async () => {
    const provider = {
      chatStream: vi.fn().mockReturnValue(mockChatStream([''])),
    } as any;
    await expect(translateSkill(
      { name: 'x', displayName: '', description: 'foo' },
      provider
    )).rejects.toThrow(/empty/);
  });
});