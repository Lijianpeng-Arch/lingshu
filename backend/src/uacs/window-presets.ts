/**
 * Phase W4 — 4 预设窗口布局
 *
 * 每个 preset 描述一组窗口 (kind + 可选 bounds)。handler 通过 emit 多个 window.create
 * 信封来应用 preset。
 *
 * 设计: 纯数据,无副作用,易测试。
 */

import type { WindowPreset } from './envelope.js';

/** 复用 electron/src/main/window-pool.ts 的 WindowKind — 但这是后端,不能 import electron。 */
export type WindowKind = 'main' | 'floating' | 'detail' | 'notify';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PresetWindow {
  kind: WindowKind;
  /** renderer 侧 hash 路由,例如 "chat" / "browser" / "skills" */
  type: string;
  bounds?: WindowBounds;
}

export interface WindowLayout {
  /** 预设内的窗口描述列表 */
  windows: PresetWindow[];
}

export interface ScenePreset {
  /** 中文显示名 (UI 渲染用) */
  name: string;
  windows: PresetWindow[];
}

export const SCENE_PRESETS: Record<WindowPreset, ScenePreset> = {
  developer: {
    name: '开发者模式',
    windows: [
      { kind: 'main', type: 'chat' },
      { kind: 'detail', type: 'browser', bounds: { x: 1200, y: 0, width: 800, height: 600 } },
      { kind: 'floating', type: 'terminal', bounds: { x: 1200, y: 620, width: 800, height: 180 } },
    ],
  },
  analyst: {
    name: '分析师模式',
    windows: [
      { kind: 'main', type: 'chat' },
      { kind: 'detail', type: 'map', bounds: { x: 1200, y: 0, width: 800, height: 600 } },
      { kind: 'floating', type: 'media', bounds: { x: 0, y: 620, width: 1200, height: 180 } },
    ],
  },
  writer: {
    name: '写作模式',
    windows: [
      { kind: 'main', type: 'chat' },
      { kind: 'detail', type: 'editor', bounds: { x: 0, y: 0, width: 2000, height: 800 } },
    ],
  },
  focus: {
    name: '专注模式',
    windows: [
      { kind: 'main', type: 'chat' },
      { kind: 'floating', type: 'thoughts', bounds: { x: 100, y: 100, width: 400, height: 300 } },
      { kind: 'floating', type: 'todos', bounds: { x: 1500, y: 100, width: 400, height: 500 } },
      { kind: 'notify', type: 'ambient', bounds: { x: 50, y: 750, width: 360, height: 80 } },
    ],
  },
};

export const PRESET_NAMES: readonly WindowPreset[] = ['developer', 'analyst', 'writer', 'focus'];

export function getPreset(p: WindowPreset): WindowLayout {
  const preset = SCENE_PRESETS[p];
  return { windows: preset.windows.map((w) => ({ ...w, bounds: w.bounds ? { ...w.bounds } : undefined })) };
}