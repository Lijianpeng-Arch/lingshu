import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSettings, saveSettings } from './settings';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('settings', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-test-'));
  const settingsPath = path.join(tmpDir, 'settings.json');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.LINGSHU_SETTINGS_PATH = settingsPath;
  });

  afterEach(() => {
    if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
    for (const file of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, file));
    fs.rmdirSync(tmpDir);
  });

  it('returns defaults when file does not exist', () => {
    const s = loadSettings();
    expect(s.mode).toBe('smart');
    expect(s.rules).toEqual([]);
  });

  it('saves and reloads rules', () => {
    saveSettings({
      mode: 'goal',
      rules: [{ permission: 'Read(**)', pattern: '**', action: 'allow' }],
    });
    const s = loadSettings();
    expect(s.mode).toBe('goal');
    expect(s.rules).toHaveLength(1);
  });

  it('throws on corrupted JSON', () => {
    fs.writeFileSync(settingsPath, '{not json');
    expect(() => loadSettings()).toThrow(/corrupted/);
  });

  it('returns defaults for new MVP fields when missing', () => {
    const s = loadSettings();
    expect(s.apiKeys).toEqual({});
    expect(s.currentProvider).toBe('mock');
    expect(s.currentModel).toBe('mock-model');
    expect(s.workspaceDir).toBe(os.homedir());
    expect(s.shellCwd).toBe(os.homedir());
  });
});
