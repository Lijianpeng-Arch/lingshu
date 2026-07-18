/**
 * Media Tool — AI 调用媒体控制能力 (Phase C.3)
 *
 * 设计: 同 C.1 browser-tool / C.2 map-tool 模式, execute 抛 NotImplemented,
 * 实际执行由主进程通过 UACS capability.invoke 接管 (Phase C.4 dispatcher 实现)。
 *
 * 工具元数据完整 (displayName/displayDescription/parameters) — 这样:
 *   - registry.register() 通过 displayName 校验
 *   - chat-handler 知道有这个工具 (生成 tool_use)
 *   - LLM 看到正确的中文描述
 *
 * C.4 会改 chat-handler: 检测 tool.name === 'media' 时跳过本地 execute,
 * 改为 emit capability.invoke envelope 给主进程 (主进程有 MediaPool + IPC)。
 */

import type { ToolDefinition } from './registry.js';

export const mediaToolDefinition: ToolDefinition = {
  name: 'media',
  displayName: '媒体',
  displayDescription: '播放音乐/视频, 控制播放/暂停/音量, 调起系统播放器',
  description:
    'Embed <audio>/<video> for local playback, or spawn the OS default player (open / start / xdg-open). ' +
    'Real execution is dispatched via UACS capability.invoke from the main process (MediaPool). ' +
    'Backend execute() throws — chat-handler detects the capability kind and routes the call.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['playMusic', 'playVideo', 'pause', 'resume', 'stop', 'volume'],
        description: '操作类型',
      },
      source: { type: 'string', description: 'URL 或本地文件路径 (play 用)' },
      title: { type: 'string', description: '标题 (play 用)' },
      artist: { type: 'string', description: '艺术家 (音乐, play 用)' },
      mode: {
        type: 'string',
        enum: ['embedded', 'external'],
        description: 'embedded 嵌入渲染端 audio/video / external 调起系统播放器 (play 用, 默认 embedded)',
      },
      volume: { type: 'number', minimum: 0, maximum: 1, description: '音量 0-1 (volume 用)' },
      mediaId: { type: 'string', description: '媒体 ID (play 后返回, pause/resume/stop 用)' },
    },
    required: ['action'],
  },
  /**
   * C.4 接管 — chat-handler 看到 tool.name === 'media' 时跳过 execute,
   * 改为 emit capability.invoke envelope 给主进程 MediaPool。
   * 这里抛 NotImplemented 防止 backend 误调。
   */
  execute: async () => {
    throw new Error(
      'MediaTool.execute: dispatched via UACS capability.invoke from main process (Phase C.4). ' +
      'Backend should never invoke this directly.',
    );
  },
};