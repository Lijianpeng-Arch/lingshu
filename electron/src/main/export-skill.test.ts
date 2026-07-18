import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateSkillPackage } from './export-skill.js';

const sample = {
  name: 'weather-lookup',
  displayName: '天气查询',
  description: '查指定城市的实时天气',
  version: '1.0.0',
  lingshuMinVersion: '2.0.0',
};

describe('exportSkill → generateSkillPackage', () => {
  it('produces a zip with manifest.json + tools/ + README.md', async () => {
    const buf = await generateSkillPackage(sample as any);
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['manifest.json', 'tools/', 'README.md']));
  });
  it('manifest.json contains chinese fields', async () => {
    const buf = await generateSkillPackage(sample as any);
    const zip = await JSZip.loadAsync(buf);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.displayName).toBe('天气查询');
    expect(manifest.description).toBe('查指定城市的实时天气');
    expect(manifest.packageVersion).toBe('1');
  });
  it('README.md is in Chinese', async () => {
    const buf = await generateSkillPackage(sample as any);
    const zip = await JSZip.loadAsync(buf);
    const readme = await zip.file('README.md')!.async('string');
    expect(readme).toContain('天气查询');
  });
});
