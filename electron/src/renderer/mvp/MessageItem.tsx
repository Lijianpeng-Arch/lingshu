/**
 * MessageItem — 单条消息 (用户 / AI)
 */

export interface MessageItemData {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  message: MessageItemData;
}

export default function MessageItem({ message }: Props) {
  const isUser = message.role === 'user';

  return (
    <div
      data-message-id={message.id}
      data-role={message.role}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        margin: '8px 0',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          margin: '0 4px 4px',
        }}
      >
        {isUser ? '我' : '灵枢'}
      </div>
      <div
        style={{
          padding: '10px 14px',
          borderRadius: 8,
          maxWidth: '80%',
          background: isUser ? 'var(--user-bubble)' : 'var(--assistant-bubble)',
          color: 'var(--text)',
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {message.content}
      </div>
    </div>
  );
}