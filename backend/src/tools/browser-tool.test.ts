/**
 * Browser Tool 单元测试 — Phase C.1
 *
 * backend ToolDefinition schema + 中文 displayName + execute 抛 NotImplemented
 */

import { describe, it, expect } from 'vitest';
import { browserToolDefinition } from './browser-tool.js';

describe('browserToolDefinition', () => {
  it('tool 定义 name=browser + 中文 displayName', () => {
    expect(browserToolDefinition.name).toBe('browser');
    expect(browserToolDefinition.displayName).toBe('浏览器');
    expect(browserToolDefinition.displayDescription).toContain('访问网页');
    expect(browserToolDefinition.displayDescription).toContain('截图');
    expect(browserToolDefinition.displayDescription).toContain('点击');
    expect(browserToolDefinition.displayDescription).toContain('填表单');
    expect(browserToolDefinition.displayDescription).toContain('提取文本');
    expect(browserToolDefinition.risk).toBe('medium');
    expect(typeof browserToolDefinition.execute).toBe('function');
  });

  it('parameters 包含 action/url/selector/value/browserId/maxLength/code/bounds', () => {
    const params = browserToolDefinition.parameters as {
      type: string;
      properties: Record<string, { type: string; enum?: string[]; description?: string }>;
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.required).toContain('action');

    // 验证所有 expected properties 都存在
    for (const key of ['action', 'url', 'browserId', 'selector', 'value', 'maxLength', 'code', 'bounds']) {
      expect(params.properties[key]).toBeTruthy();
      expect(params.properties[key]!.type).toBeTruthy();
    }

    // action 必须是 enum
    expect(params.properties.action!.enum).toContain('create');
    expect(params.properties.action!.enum).toContain('navigate');
    expect(params.properties.action!.enum).toContain('screenshot');
    expect(params.properties.action!.enum).toContain('extract');
    expect(params.properties.action!.enum).toContain('click');
    expect(params.properties.action!.enum).toContain('fill');
    expect(params.properties.action!.enum).toContain('list');
    expect(params.properties.action!.enum).toContain('destroy');

    // url/browserId/selector/value 必须是 string
    expect(params.properties.url!.type).toBe('string');
    expect(params.properties.browserId!.type).toBe('string');
    expect(params.properties.selector!.type).toBe('string');
    expect(params.properties.value!.type).toBe('string');
  });

  it('execute 抛 NotImplemented (c4 接管)', async () => {
    await expect(browserToolDefinition.execute({ action: 'navigate' })).rejects.toThrow(
      /dispatched via UACS capability\.invoke/i,
    );
    // 错误信息要明确指向 C.4,不能误导 backend 调用
    try {
      await browserToolDefinition.execute({ action: 'list' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('Phase C.4');
      expect(msg).toContain('main process');
    }
  });
});