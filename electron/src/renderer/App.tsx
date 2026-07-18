/**
 * App.tsx — 灵枢应用入口
 *
 * 渲染极简聊天界面 (ChatPanel)。启动时检查 settings:
 * 未配 API key + provider=mock 时,顶部显示 WelcomeBanner 引导去设置填 key。
 */
import { useEffect, useState } from 'react';
import ChatPanel from './mvp/ChatPanel';
import WelcomeBanner from './mvp/WelcomeBanner';
import SettingsModal from './mvp/SettingsModal';

export default function App() {
  const [showBanner, setShowBanner] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 启动时检查 settings, 决定要不要显示 WelcomeBanner
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((s) => {
        const hasKey = Object.values(s.apiKeys || {}).some((v) => typeof v === 'string' && v.length > 0);
        if (!hasKey && s.currentProvider === 'mock') {
          setShowBanner(true);
        }
      })
      .catch((err) => {
        console.error('Failed to load settings for banner:', err);
        // 后端没起或 5xx: 显示红色 banner, 提示用户检查后端
        setShowBanner(true);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <>
      {showBanner && (
        <WelcomeBanner
          error={loadError}
          onOpenSettings={() => {
            setShowBanner(false);
            setLoadError(null);
            setShowSettings(true);
          }}
          onDismiss={() => {
            setShowBanner(false);
            setLoadError(null);
          }}
        />
      )}
      <ChatPanel />
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
}