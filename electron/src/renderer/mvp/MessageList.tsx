/**
 * MessageList — 消息列表容器
 */
import MessageItem, { type MessageItemData } from './MessageItem';

interface Props {
  messages: MessageItemData[];
}

export default function MessageList({ messages }: Props) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: 16,
      }}
    >
      {messages.length === 0 ? (
        <div
          style={{
            color: 'var(--text-muted)',
            textAlign: 'center',
            marginTop: 40,
            fontSize: 13,
          }}
        >
          开始对话吧
        </div>
      ) : (
        messages.map((m) => <MessageItem key={m.id} message={m} />)
      )}
    </div>
  );
}