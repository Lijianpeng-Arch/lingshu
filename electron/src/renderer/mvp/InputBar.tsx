/**
 * InputBar — 底部输入框 (Phase 1.5)
 */
import { useState, type KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export default function InputBar({ onSend, disabled = false }: Props) {
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
      }}
    >
      <textarea
        data-testid="input"
        placeholder="输入消息，回车发送 (Shift+Enter 换行)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        style={{
          flex: 1,
          padding: '10px 14px',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-input)',
          color: 'var(--text)',
          fontSize: 14,
          outline: 'none',
          resize: 'none',
          minHeight: 40,
          maxHeight: 120,
        }}
      />
      <button
        data-testid="send-button"
        onClick={submit}
        disabled={disabled || !text.trim()}
        style={{
          padding: '10px 20px',
          background: disabled || !text.trim() ? '#3d3d45' : 'var(--accent)',
          color: 'white',
          border: 'none',
          borderRadius: 8,
          cursor: disabled || !text.trim() ? 'not-allowed' : 'pointer',
          fontSize: 14,
        }}
      >
        发送
      </button>
    </div>
  );
}