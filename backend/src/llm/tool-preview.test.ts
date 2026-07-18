import { describe, it, expect } from 'vitest';
import { buildToolPreview } from './tool-preview.js';
import type { ToolDefinition } from '../tools/registry.js';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    displayName: `中文${name}`,
    displayDescription: `desc ${name}`,
    description: 'en',
    parameters: {},
    risk: 'low',
    execute: async () => ({}),
  };
}

describe('buildToolPreview', () => {
  it('run_command: 中文 + 命令片段', () => {
    const p = buildToolPreview(makeTool('run_command'), { command: 'ls -la' });
    expect(p.previewText).toContain('准备执行');
    expect(p.previewText).toContain('ls -la');
  });
  it('read_file: 路径 + 分段提示', () => {
    const p = buildToolPreview(makeTool('read_file'), { path: 'a.md', offset: 0, limit: 100 });
    expect(p.previewText).toContain('准备读取');
    expect(p.previewText).toContain('a.md');
    expect(p.previewText).toContain('分段');
  });
  it('read_file: 无 offset/limit 不显示分段', () => {
    const p = buildToolPreview(makeTool('read_file'), { path: 'a.md' });
    expect(p.previewText).not.toContain('分段');
  });
  it('list_files: 默认当前目录', () => {
    const p = buildToolPreview(makeTool('list_files'), {});
    expect(p.previewText).toContain('当前目录');
  });
  it('web_search: 搜索词', () => {
    const p = buildToolPreview(makeTool('web_search'), { query: '天气' });
    expect(p.previewText).toContain('天气');
  });
  it('unknown tool: fallback', () => {
    const p = buildToolPreview(makeTool('mystery'), {});
    expect(p.previewText).toContain('准备调用');
  });
  it('truncates long commands', () => {
    const longCmd = 'x'.repeat(200);
    const p = buildToolPreview(makeTool('run_command'), { command: longCmd });
    expect(p.previewText.length).toBeLessThan(150);
  });
});
