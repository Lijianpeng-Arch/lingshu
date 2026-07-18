/**
 * Map Tool 单元测试 — Phase C.2
 *
 * backend ToolDefinition schema + 中文 displayName + execute 抛 NotImplemented。
 */

import { describe, it, expect } from 'vitest';
import { mapToolDefinition } from './map-tool.js';

describe('mapToolDefinition', () => {
  it('tool 定义 name=map + 中文 displayName + 中文 description', () => {
    expect(mapToolDefinition.name).toBe('map');
    expect(mapToolDefinition.displayName).toBe('地图');
    expect(mapToolDefinition.displayDescription).toContain('显示');
    expect(mapToolDefinition.displayDescription).toContain('位置');
    expect(mapToolDefinition.displayDescription).toContain('路径');
    expect(mapToolDefinition.displayDescription).toContain('POI');
    expect(mapToolDefinition.displayDescription).toContain('高德');
    expect(mapToolDefinition.risk).toBe('low');
    expect(typeof mapToolDefinition.execute).toBe('function');
  });

  it('parameters 包含 action/location/path/category/near/provider/typhoonName', () => {
    const params = mapToolDefinition.parameters as {
      type: string;
      properties: Record<string, { type: string; enum?: string[]; description?: string }>;
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.required).toContain('action');

    for (const key of ['action', 'location', 'path', 'city', 'category', 'near', 'radiusMeters', 'typhoonName', 'provider']) {
      expect(params.properties[key]).toBeTruthy();
      expect(params.properties[key]!.type).toBeTruthy();
    }

    // action enum 必须包含 4 种
    expect(params.properties.action!.enum).toContain('showLocation');
    expect(params.properties.action!.enum).toContain('showPath');
    expect(params.properties.action!.enum).toContain('showPOI');
    expect(params.properties.action!.enum).toContain('showTyphoon');

    // provider enum
    expect(params.properties.provider!.enum).toContain('amap');
    expect(params.properties.provider!.enum).toContain('mapbox');
    expect(params.properties.provider!.enum).toContain('osm');
  });
});