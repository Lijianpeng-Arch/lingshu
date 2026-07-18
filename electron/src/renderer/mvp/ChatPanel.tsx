/**
 * ChatPanel — MVP 聊天面板 (Phase 1.7 接通真组件)
 *
 * 组合:
 * - SessionList (左侧)
 * - ModelSelector (顶)
 * - MessageList (中)
 * - InputBar (底)
 *
 * 数据:
 * - useChat hook (SSE 流式)
 * - /api/providers (provider 列表)
 */

import { useEffect, useState } from 'react';
import MessageList from './MessageList';
import InputBar from './InputBar';
import ModelSelector, { type ProviderInfo, type Selection } from './ModelSelector';
import SessionList, { type SessionInfo } from './SessionList';
import { useChat } from './useChat';
import SettingsModal from './SettingsModal';

const MOCK_PROVIDERS: ProviderInfo[] = [
  {
    provider: 'mock',
    available: true,
    models: [{ name: 'mock-model', label: 'Mock Model' }],
  },
];

export default function ChatPanel() {
  const [providers, setProviders] = useState<ProviderInfo[]>(MOCK_PROVIDERS);
  const [selection, setSelection] = useState<Selection>({
    provider: 'mock',
    model: 'mock-model',
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { messages, send, isStreaming, error } = useChat({
    sessionId: currentSessionId ?? 'default',
  });

  // 启动时拉 /api/providers
  useEffect(() => {
    let cancelled = false;
    fetch('/api/providers')
      .then((r) => r.json())
      .then((data: ProviderInfo[]) => {
        if (cancelled) return;
        if (Array.isArray(data) && data.length > 0) {
          setProviders(data);
          const firstProvider = data[0];
          const firstModel = firstProvider.models[0];
          if (firstProvider && firstModel) {
            setSelection({
              provider: firstProvider.provider,
              model: firstModel.name,
            });
          }
        }
      })
      .catch(() => {
        // 拉失败保留 mock,UI 不崩
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSend = async (text: string) => {
    // 第一次发送时自动建一个 session
    let sid = currentSessionId;
    if (!sid) {
      sid = `session-${Date.now()}`;
      const newSession: SessionInfo = {
        id: sid,
        title: text.slice(0, 20) || '新会话',
        createdAt: Date.now(),
      };
      setSessions((prev) => [newSession, ...prev]);
      setCurrentSessionId(sid);
    }
    await send(text, selection);
  };

  const handleCreateSession = () => {
    const sid = `session-${Date.now()}`;
    setSessions((prev) => [
      { id: sid, title: '新会话', createdAt: Date.now() },
      ...prev,
    ]);
    setCurrentSessionId(sid);
  };

  return (
    <div
      data-testid="chat-panel"
      style={{
        display: 'flex',
        height: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <SessionList
        sessions={sessions}
        currentId={currentSessionId}
        onSelect={setCurrentSessionId}
        onCreate={handleCreateSession}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
        }}
      >
        <header
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            fontSize: 15,
            fontWeight: 500,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>灵枢</span>
          <button
            onClick={() => setShowSettings(true)}
            aria-label="设置"
            data-testid="settings-button"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text)',
              fontSize: 18,
              cursor: 'pointer',
            }}
          >
            ⚙
          </button>
        </header>
        <ModelSelector
          providers={providers}
          value={selection}
          onChange={setSelection}
        />
        {error ? (
          <div
            data-testid="error-banner"
            style={{
              padding: '8px 16px',
              background: '#7f1d1d',
              color: '#fecaca',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        ) : null}
        <MessageList messages={messages} />
        <InputBar onSend={handleSend} disabled={isStreaming} />
      </div>
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}