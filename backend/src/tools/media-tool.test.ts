/**
 * Media Tool 单元测试 — Phase C.3
 *
 * backend ToolDefinition schema + 中文 displayName + execute 抛 NotImplemented。
 */

import { describe, it, expect } from 'vitest';
import { mediaToolDefinition } from './media-tool.js';

describe('mediaToolDefinition', () => {
  it('tool 定义 name=media + 中文 displayName + 中文 description', () => {
    expect(mediaToolDefinition.name).toBe('media');
    expect(mediaToolDefinition.displayName).toBe('媒体');
    expect(mediaToolDefinition.displayDescription).toContain('音乐');
    expect(mediaToolDefinition.displayDescription).toContain('视频');
    expect(mediaToolDefinition.displayDescription).toContain('播放');
    expect(mediaToolDefinition.displayDescription).toContain('暂停');
    expect(mediaToolDefinition.displayDescription).toContain('系统播放器');
    expect(mediaToolDefinition.risk).toBe('low');
    expect(typeof mediaToolDefinition.execute).toBe('function');
  });

  it('parameters 包含 action/source/title/artist/mode/volume/mediaId', () => {
    const params = mediaToolDefinition.parameters as {
      type: string;
      properties: Record<string, {
        type: string;
        enum?: string[];
        description?: string;
        minimum?: number;
        maximum?: number;
      }>;
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.required).toContain('action');

    // 验证所有 expected properties 都存在
    for (const key of ['action', 'source', 'title', 'artist', 'mode', 'volume', 'mediaId']) {
      expect(params.properties[key]).toBeTruthy();
      expect(params.properties[key]!.type).toBeTruthy();
    }

    // action 必须是 enum,包含 6 种操作
    expect(params.properties.action!.enum).toContain('playMusic');
    expect(params.properties.action!.enum).toContain('playVideo');
    expect(params.properties.action!.enum).toContain('pause');
    expect(params.properties.action!.enum).toContain('resume');
    expect(params.properties.action!.enum).toContain('stop');
    expect(params.properties.action!.enum).toContain('volume');

    // mode enum
    expect(params.properties.mode!.enum).toContain('embedded');
    expect(params.properties.mode!.enum).toContain('external');

    // volume 必须有 min/max 0-1
    expect(params.properties.volume!.minimum).toBe(0);
    expect(params.properties.volume!.maximum).toBe(1);

    // source/title/artist/mediaId 必须是 string
    expect(params.properties.source!.type).toBe('string');
    expect(params.properties.title!.type).toBe('string');
    expect(params.properties.artist!.type).toBe('string');
    expect(params.properties.mediaId!.type).toBe('string');
  });
});