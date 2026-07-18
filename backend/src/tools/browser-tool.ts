/**
 * Browser Tool — 让 AI 在 chat 中调用浏览器 (Phase C.1)
 *
 * 设计: 后端不能直接 require electron (隔离),所以 execute 抛 NotImplemented,
 * 实际执行由主进程通过 UACS capability.invoke 接管 (Phase C.4 dispatcher 实现)。
 *
 * 工具元数据完整 (displayName/displayDescription/parameters) — 这样:
 *   - registry.register() 通过 displayName 校验
 *   - chat-handler 知道有这个工具 (生成 tool_use)
 *   - LLM 看到正确的中文描述
 *
 * C.4 会改 chat-handler: 检测 tool.name === 'browser' 时跳过本地 execute,
 * 改为 emit capability.invoke envelope 给主进程 (主进程有 BrowserPool)。
 */

import type { ToolDefinition } from './registry.js';

export const browserToolDefinition: ToolDefinition = {
  name: 'browser',
  displayName: '浏览器',
  displayDescription: '访问网页 / 截图 / 点击 / 填表单 / 提取文本, 像真人用浏览器',
  description:
    'Embed an Electron WebContentsView and let the agent navigate / screenshot / click / fill / extract text. ' +
    'Real execution is dispatched via UACS capability.invoke from the main process (BrowserPool). ' +
    'Backend execute() throws — chat-handler detects the capability kind and routes the call.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'navigate', 'screenshot', 'extract', 'extractHTML', 'click', 'fill', 'execute', 'list', 'destroy', 'setBounds'],
        description: '操作类型',
      },
      url: { type: 'string', description: 'URL (navigate 用)' },
      browserId: { type: 'string', description: '浏览器 ID (create 后返回, 后续操作要传)' },
      selector: { type: 'string', description: 'CSS 选择器 (click/fill/extract 用)' },
      value: { type: 'string', description: '填入值 (fill 用)' },
      maxLength: { type: 'number', description: '提取文本最大字符数 (extract 用)' },
      code: { type: 'string', description: 'JS 代码 (execute 用)' },
      bounds: {
        type: 'object',
        description: 'bounds {x,y,width,height} (setBounds 用)',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
    },
    required: ['action'],
  },
  /**
   * C.4 接管 — chat-handler 看到 tool.name === 'browser' 时跳过 execute,
   * 改为 emit capability.invoke envelope 给主进程 BrowserPool。
   * 这里抛 NotImplemented 防止 backend 误调。
   */
  execute: async () => {
    throw new Error(
      'BrowserTool.execute: dispatched via UACS capability.invoke from main process (Phase C.4). ' +
      'Backend should never invoke this directly.',
    );
  },
};