import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Mode, Rule } from './types';

export interface Settings {
  mode: Mode;
  rules: Rule[];
  permissionTimeoutSeconds?: number;
  // MVP Phase 5 新增字段
  apiKeys?: {
    deepseek?: string;
    openai?: string;
    anthropic?: string;
    ollama?: string;
  };
  currentProvider?: 'deepseek' | 'openai' | 'anthropic' | 'ollama' | 'mock';
  currentModel?: string;
  workspaceDir?: string;
  shellCwd?: string;
}

const DEFAULTS: Settings = {
  mode: 'smart',
  rules: [],
  permissionTimeoutSeconds: 60,
  apiKeys: {},
  currentProvider: 'mock',
  currentModel: 'mock-model',
  workspaceDir: os.homedir(),
  shellCwd: os.homedir(),
};

function settingsPath(): string {
  return process.env.LINGSHU_SETTINGS_PATH
    ?? path.join(os.homedir(), '.lingshu', 'settings.json');
}

export function loadSettings(): Settings {
  const p = settingsPath();
  if (!fs.existsSync(p)) return { ...DEFAULTS, rules: [] };

  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      mode: parsed.mode ?? DEFAULTS.mode,
      rules: parsed.rules ?? DEFAULTS.rules,
      permissionTimeoutSeconds: parsed.permissionTimeoutSeconds ?? DEFAULTS.permissionTimeoutSeconds,
      // 新字段向后兼容 — 缺省给默认值
      apiKeys: parsed.apiKeys ?? {},
      currentProvider: parsed.currentProvider ?? DEFAULTS.currentProvider,
      currentModel: parsed.currentModel ?? DEFAULTS.currentModel,
      workspaceDir: parsed.workspaceDir ?? DEFAULTS.workspaceDir,
      shellCwd: parsed.shellCwd ?? DEFAULTS.shellCwd,
    };
  } catch {
    const backup = `${p}.corrupt.${Date.now()}`;
    fs.copyFileSync(p, backup);
    throw new Error(`Settings corrupted, backed up to ${backup}`);
  }
}

export function saveSettings(s: Settings): void {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, p);
}
