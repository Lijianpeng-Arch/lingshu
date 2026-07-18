import { describe, it, expect, beforeEach } from 'vitest';
import { createToolRegistry, ToolNameProtectedError } from './registry.js';
import type { ToolDefinition } from './registry.js';

const fakeTool: ToolDefinition = {
  name: 'fake_tool',
  displayName: '假工具',
  displayDescription: '用于测试的假工具',
  description: 'fake',
  parameters: { type: 'object' },
  risk: 'low',
  execute: async () => ({ ok: true }),
};

describe('createToolRegistry', () => {
  let reg: ReturnType<typeof createToolRegistry>;
  beforeEach(() => { reg = createToolRegistry(); });

  it('registers a tool', () => {
    reg.register(fakeTool);
    expect(reg.get('fake_tool')?.name).toBe('fake_tool');
  });
  it('rejects protected name on unregister only (register allows builtin name)', () => {
    // builtin 注册路径(内部 register)允许同名 — 保护检查只在 MCP 入口或 unregister。
    reg.register({ ...fakeTool, name: 'send_message' });
    expect(reg.get('send_message')?.name).toBe('send_message');
    expect(() => reg.unregister('send_message')).toThrow(ToolNameProtectedError);
  });
  it('list returns all tools', () => {
    reg.register(fakeTool);
    reg.register({ ...fakeTool, name: 'other' });
    expect(reg.list().map(t => t.name).sort()).toEqual(['fake_tool', 'other']);
  });
  it('setProfile + getProfile', () => {
    reg.register(fakeTool);
    reg.register({ ...fakeTool, name: 'other' });
    reg.setProfile('desktop', ['fake_tool', 'other']);
    expect(reg.getProfile('desktop')).toEqual(['fake_tool', 'other']);
  });
  it('getProfileTools returns ToolDefinition[] filtered by profile', () => {
    reg.register(fakeTool);
    reg.register({ ...fakeTool, name: 'other' });
    reg.setProfile('tray', ['fake_tool']);
    expect(reg.getProfileTools('tray').map(t => t.name)).toEqual(['fake_tool']);
  });
  it('getProfileTools skips unknown gracefully', () => {
    reg.register(fakeTool);
    reg.setProfile('tray', ['fake_tool', 'nonexistent']);
    expect(reg.getProfileTools('tray').map(t => t.name)).toEqual(['fake_tool']);
  });
  it('BUILTIN_PROTECTED contains critical names', () => {
    expect(reg.protectedNames.has('send_message')).toBe(true);
  });
  it('rejects tool without displayName', () => {
    const bad = { ...fakeTool, name: 'bad1', displayName: '' };
    expect(() => reg.register(bad)).toThrow(/displayName/);
  });
  it('rejects tool without displayDescription', () => {
    const bad = { ...fakeTool, name: 'bad2', displayDescription: '' };
    expect(() => reg.register(bad)).toThrow(/displayDescription/);
  });
  it('accepts tool with both chinese fields', () => {
    reg.register({ ...fakeTool, name: 'good_tool' });
    const t = reg.get('good_tool');
    expect(t?.displayName).toBe('假工具');
    expect(t?.displayDescription).toBe('用于测试的假工具');
  });
});
