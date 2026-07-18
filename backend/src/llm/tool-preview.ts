/**
 * 命令预览层 — LLM tool_use 之后,实际执行之前,emit 中文 preview 信封
 *
 * UI 显示 "准备执行: <displayName>" + 折叠区看 raw(本 spec 不实现 UI 折叠,
 * 仅后端生成 preview 文本)。
 */

import type { ToolDefinition } from '../tools/registry.js';

export interface ToolPreview {
  toolName: string;
  displayName: string;
  displayDescription: string;
  previewText: string;
  args: Record<string, unknown>;
}

export function buildToolPreview(tool: ToolDefinition, args: Record<string, unknown>): ToolPreview {
  const previewText = generatePreviewText(tool, args);
  return {
    toolName: tool.name,
    displayName: tool.displayName,
    displayDescription: tool.displayDescription,
    previewText,
    args,
  };
}

function generatePreviewText(tool: ToolDefinition, args: Record<string, unknown>): string {
  switch (tool.name) {
    case 'run_command': return `准备执行: ${tool.displayName}(${truncate(String(args.command ?? ''), 50)})`;
    case 'read_file':   return `准备读取: ${args.path ?? '(未指定路径)'}${args.offset || args.limit ? ' (分段)' : ''}`;
    case 'list_files':  return `准备列出: ${args.path ?? '当前目录'} 下的文件`;
    case 'web_search':  return `准备搜索: "${args.query ?? ''}"`;
    default:            return `准备调用: ${tool.displayName}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
