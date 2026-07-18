import { describe, it, expect } from 'vitest';
import { classifySkillType } from './skill-types.js';

describe('classifySkillType', () => {
  it('"总结文章" 是 prompt 层', () => {
    const r = classifySkillType('总结文章');
    expect(r.layer).toBe('prompt');
  });

  it('"查 GitHub 仓库" 是 api 层', () => {
    const r = classifySkillType('查 GitHub 仓库');
    expect(r.layer).toBe('api');
  });

  it('"查天气" 是 api 层(外部数据)', () => {
    const r = classifySkillType('查天气');
    expect(r.layer).toBe('api');
  });

  it('"翻译英文" 是 prompt 层', () => {
    const r = classifySkillType('翻译英文');
    expect(r.layer).toBe('prompt');
  });

  it('MCP 层留 placeholder', () => {
    const r = classifySkillType('通过 MCP 协议接入');
    // MCP 暂时按 api 处理(MCP 留 Phase E)
    expect(['api', 'mcp']).toContain(r.layer);
  });
});
