/**
 * Map Tool — AI 调用地图能力 (Phase C.2)
 *
 * 设计: 同 C.1 browser-tool 模式, execute 抛 NotImplemented,
 * 实际执行由主进程通过 UACS capability.invoke 接管 (Phase C.4 dispatcher 实现)。
 *
 * 工具元数据完整 (displayName/displayDescription/parameters) — 这样:
 *   - registry.register() 通过 displayName 校验
 *   - chat-handler 知道有这个工具 (生成 tool_use)
 *   - LLM 看到正确的中文描述
 *
 * C.4 会改 chat-handler: 检测 tool.name === 'map' 时跳过本地 execute,
 * 改为 emit capability.invoke envelope 给主进程 (主进程有 MapPanel 渲染 + IPC)。
 */

import type { ToolDefinition } from './registry.js';

export const mapToolDefinition: ToolDefinition = {
  name: 'map',
  displayName: '地图',
  displayDescription: '显示位置/路径/POI/台风路径, 支持高德/Mapbox/OSM',
  description:
    'Embed an iframe-based map (Amap / Mapbox / OSM) and let the agent show location / path / POI / typhoon tracks. ' +
    'Real execution is dispatched via UACS capability.invoke from the main process (MapPanel). ' +
    'Backend execute() throws — chat-handler detects the capability kind and routes the call.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['showLocation', 'showPath', 'showPOI', 'showTyphoon'],
        description: '操作类型',
      },
      location: {
        type: 'object',
        description: '{ lng, lat, label? } (location 用)',
        properties: {
          lng: { type: 'number' },
          lat: { type: 'number' },
          label: { type: 'string' },
        },
      },
      path: {
        type: 'array',
        description: '路径点数组 [{ lng, lat, time?, label? }] (path / typhoon 用)',
        items: {
          type: 'object',
          properties: {
            lng: { type: 'number' },
            lat: { type: 'number' },
            time: { type: 'number' },
            label: { type: 'string' },
          },
        },
      },
      city: { type: 'string', description: '城市名 (location 用, 可选)' },
      category: { type: 'string', description: 'POI 分类 (poi 用, e.g. 餐厅/加油站)' },
      near: {
        type: 'object',
        description: 'POI 中心点 { lng, lat }',
        properties: {
          lng: { type: 'number' },
          lat: { type: 'number' },
        },
      },
      radiusMeters: { type: 'number', description: 'POI 搜索半径 (默认 1000)' },
      typhoonName: { type: 'string', description: '台风名 (typhoon 用)' },
      provider: {
        type: 'string',
        enum: ['amap', 'mapbox', 'osm'],
        description: '地图 provider (默认 amap)',
      },
    },
    required: ['action'],
  },
  /**
   * C.4 接管 — chat-handler 看到 tool.name === 'map' 时跳过 execute,
   * 改为 emit capability.invoke envelope 给主进程 MapPanel。
   * 这里抛 NotImplemented 防止 backend 误调。
   */
  execute: async () => {
    throw new Error(
      'MapTool.execute: dispatched via UACS capability.invoke from main process (Phase C.4). ' +
      'Backend should never invoke this directly.',
    );
  },
};