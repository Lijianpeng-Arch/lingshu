/**
 * ModelSelector — 模型选择器 (Phase 1.6)
 *
 * MVP key 映射 (后端 V6 路由 key → 用户视角显示名):
 *   openai   → OpenAI (GPT-4o, GPT-4o mini)
 *   claude   → Anthropic (Claude 3.5 Sonnet, Claude 3 Haiku)
 *   ollama   → 通义千问 (本地 Qwen 2.5 7B, MVP 通过 ollama 接口)
 *   deepseek → DeepSeek (DeepSeek Chat)
 *
 * 后端真实 key 不变;前端只在 UI 显示时映射。
 */

export interface ProviderInfo {
  provider: string;
  available: boolean;
  models: Array<{ name: string; label: string }>;
}

export interface Selection {
  provider: string;
  model: string;
}

const DISPLAY_NAME: Record<string, string> = {
  openai: 'OpenAI',
  claude: 'Anthropic',
  ollama: '通义千问 (本地)',
  deepseek: 'DeepSeek',
};

interface Props {
  providers: ProviderInfo[];
  value: Selection;
  onChange: (s: Selection) => void;
}

export default function ModelSelector({ providers, value, onChange }: Props) {
  const flat = providers.flatMap((p) =>
    p.models.map((m) => ({
      key: `${p.provider}:${m.name}`,
      provider: p.provider,
      model: m.name,
      label: `${DISPLAY_NAME[p.provider] ?? p.provider} / ${m.label}`,
    })),
  );

  const currentValue = `${value.provider}:${value.model}`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>模型</span>
      <select
        data-testid="model-selector"
        value={currentValue}
        onChange={(e) => {
          const [provider, model] = e.target.value.split(':');
          onChange({ provider, model });
        }}
        style={{
          padding: '6px 12px',
          background: 'var(--bg-input)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 13,
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {flat.map((opt) => (
          <option key={opt.key} value={opt.key}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}