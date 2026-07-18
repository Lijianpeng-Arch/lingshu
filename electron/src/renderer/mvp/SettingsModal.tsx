import { useEffect, useState } from 'react';
import styles from './SettingsModal.module.css';

interface Settings {
  mode: string;
  rules: unknown[];
  permissionTimeoutSeconds?: number;
  apiKeys: {
    deepseek?: string;
    openai?: string;
    anthropic?: string;
    ollama?: string;
  };
  currentProvider: string;
  currentModel: string;
  workspaceDir: string;
  shellCwd: string;
  availableProviders: string[];
}

const PROVIDER_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-chat'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  anthropic: ['claude-3-5-sonnet', 'claude-3-haiku'],
  ollama: ['qwen2.5:7b', 'llama3.1'],
  mock: ['mock-model'],
};

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/api/settings')
      .then((r) => r.json())
      .then(setSettings)
      .catch((err) => console.error('Failed to load settings:', err));
  }, [open]);

  if (!open || !settings) return null;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings({ ...settings, [key]: value });
  };

  const updateApiKey = (provider: keyof Settings['apiKeys'], value: string) => {
    setSettings({ ...settings, apiKeys: { ...settings.apiKeys, [provider]: value } });
  };

  const handleTest = async () => {
    const apiKey = settings.apiKeys[settings.currentProvider as keyof Settings['apiKeys']];
    if (!apiKey) {
      setTestResult({ ok: false, error: 'API key 为空' });
      return;
    }
    setTestResult(null);
    const res = await fetch('/api/settings/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: settings.currentProvider, apiKey }),
    });
    const data = await res.json();
    setTestResult(data);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKeys: settings.apiKeys,
          currentProvider: settings.currentProvider,
          currentModel: settings.currentModel,
          workspaceDir: settings.workspaceDir,
          shellCwd: settings.shellCwd,
          mode: settings.mode,
          permissionTimeoutSeconds: settings.permissionTimeoutSeconds,
        }),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const providerModels = PROVIDER_MODELS[settings.currentProvider] ?? [];

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>⚙ 设置</h2>
          <button className={styles.close} onClick={onClose}>×</button>
        </div>

        <section className={styles.section}>
          <h3>🤖 模型选择</h3>
          <label>
            Provider:
            <select
              value={settings.currentProvider}
              onChange={(e) => {
                const p = e.target.value;
                const defaultModel = PROVIDER_MODELS[p]?.[0] ?? '';
                setSettings({ ...settings, currentProvider: p, currentModel: defaultModel });
              }}
            >
              {['deepseek', 'openai', 'anthropic', 'ollama', 'mock'].map((p) => (
                <option key={p} value={p}>
                  {p} {settings.availableProviders.includes(p) ? '' : '(未配置 key)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model:
            <select
              value={settings.currentModel}
              onChange={(e) => update('currentModel', e.target.value)}
            >
              {providerModels.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <button onClick={handleTest}>测试连接</button>
          {testResult && (
            <span className={testResult.ok ? styles.ok : styles.err}>
              {testResult.ok ? `✅ ${testResult.latencyMs}ms` : `❌ ${testResult.error}`}
            </span>
          )}
        </section>

        <section className={styles.section}>
          <h3>🔑 API Keys</h3>
          {(['deepseek', 'openai', 'anthropic', 'ollama'] as const).map((p) => (
            <label key={p}>
              {p}:
              <input
                type="password"
                value={settings.apiKeys[p] ?? ''}
                onChange={(e) => updateApiKey(p, e.target.value)}
                placeholder={`输入 ${p} API key`}
              />
            </label>
          ))}
        </section>

        <section className={styles.section}>
          <h3>📁 工作目录</h3>
          <label>
            文件根:
            <input
              type="text"
              value={settings.workspaceDir}
              onChange={(e) => update('workspaceDir', e.target.value)}
            />
          </label>
          <label>
            命令工作目录:
            <input
              type="text"
              value={settings.shellCwd}
              onChange={(e) => update('shellCwd', e.target.value)}
            />
          </label>
        </section>

        <section className={styles.section}>
          <h3>🔒 权限</h3>
          <label>
            模式:
            <select value={settings.mode} onChange={(e) => update('mode', e.target.value)}>
              <option value="smart">smart (推荐)</option>
              <option value="plan">plan</option>
              <option value="goal">goal</option>
            </select>
          </label>
          <label>
            超时:
            <input
              type="number"
              value={settings.permissionTimeoutSeconds ?? 60}
              onChange={(e) => update('permissionTimeoutSeconds', Number(e.target.value))}
            /> 秒
          </label>
        </section>

        <div className={styles.footer}>
          <button onClick={onClose} disabled={saving}>取消</button>
          <button onClick={handleSave} disabled={saving} className={styles.primary}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}