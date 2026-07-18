import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectLocalSkill, installLocalSkill, previewLocalSkillTranslation } from './local-installer.js';

let root: string;
let sourceDir: string;
let skillsDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-local-install-'));
  sourceDir = path.join(root, 'source');
  skillsDir = path.join(root, 'installed');
  await fs.mkdir(sourceDir, { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function writeSourceManifest(manifest: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

function fakeProvider(text: string) {
  return { chatStream: async function* () { yield { delta: text }; } } as any;
}

function throwingProvider() {
  return { chatStream: async function* () { throw new Error('network down'); } } as any;
}

it('rejects a directory without manifest.json in Chinese', async () => {
  await expect(inspectLocalSkill(sourceDir)).rejects.toThrow('找不到 manifest.json');
});

it('auto translation returns preview without modifying source or target', async () => {
  await writeSourceManifest({
    name: 'weather-query', description: 'Get weather', version: '1.0.0', lingshuMinVersion: '2.0.0',
  });
  const before = await fs.readFile(path.join(sourceDir, 'manifest.json'), 'utf8');
  const result = await previewLocalSkillTranslation({ sourceDir, provider: fakeProvider('天气查询|查询指定城市的天气') });
  expect(result).toEqual({ ok: true, displayName: '天气查询', description: '查询指定城市的天气' });
  expect(await fs.readFile(path.join(sourceDir, 'manifest.json'), 'utf8')).toBe(before);
  await expect(fs.access(skillsDir)).rejects.toBeTruthy();
});

it('returns manual fallback when automatic translation fails', async () => {
  await writeSourceManifest({
    name: 'weather-query', description: 'Get weather', version: '1.0.0', lingshuMinVersion: '2.0.0',
  });
  await expect(previewLocalSkillTranslation({ sourceDir, provider: throwingProvider() })).resolves.toEqual({
    ok: false,
    needsManual: true,
    message: '自动翻译暂时不可用，请手动填写中文信息',
  });
});

it('confirmed Chinese metadata writes back and copies the full directory', async () => {
  await writeSourceManifest({
    name: 'weather-query', description: 'Get weather', version: '1.0.0', lingshuMinVersion: '2.0.0',
  });
  await fs.writeFile(path.join(sourceDir, 'tool.json'), '{"name":"weather"}');
  const result = await installLocalSkill({
    sourceDir,
    choice: { mode: 'manual', displayName: '天气查询', description: '查询指定城市的天气' },
    skillsDir,
  });
  expect(result).toMatchObject({ ok: true, skill: { displayName: '天气查询' } });
  const sourceManifest = JSON.parse(await fs.readFile(path.join(sourceDir, 'manifest.json'), 'utf8'));
  expect(sourceManifest.description).toBe('查询指定城市的天气');
  expect(await fs.readFile(path.join(skillsDir, 'weather-query', 'tool.json'), 'utf8')).toContain('weather');
});
