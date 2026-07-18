/**
 * SessionList — 左侧会话列表 (Phase 1.8)
 *
 * MVP 阶段先做 UI,数据从后端 /api/sessions 拉 (Phase 5 接入)。
 * 当前会话用 currentId 高亮。
 */

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
}

interface Props {
  sessions: SessionInfo[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export default function SessionList({ sessions, currentId, onSelect, onCreate }: Props) {
  return (
    <div
      style={{
        width: 200,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
        padding: '12px 0',
        overflowY: 'auto',
        flexShrink: 0,
      }}
    >
      <button
        data-testid="new-session"
        onClick={onCreate}
        style={{
          margin: '0 12px 12px',
          padding: '8px 12px',
          background: 'var(--accent)',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 13,
          width: 'calc(100% - 24px)',
        }}
      >
        + 新会话
      </button>
      {sessions.length === 0 ? (
        <div
          style={{
            padding: '12px 16px',
            color: 'var(--text-muted)',
            fontSize: 12,
            textAlign: 'center',
          }}
        >
          暂无会话
        </div>
      ) : (
        sessions.map((s) => {
          const isCurrent = s.id === currentId;
          return (
            <div
              key={s.id}
              data-session-id={s.id}
              data-current={isCurrent ? 'true' : 'false'}
              onClick={() => onSelect(s.id)}
              style={{
                padding: '10px 16px',
                cursor: 'pointer',
                fontSize: 13,
                color: isCurrent ? 'var(--text)' : 'var(--text-muted)',
                background: isCurrent ? 'var(--bg-input)' : 'transparent',
                borderLeft: isCurrent
                  ? '2px solid var(--accent)'
                  : '2px solid transparent',
              }}
            >
              {s.title}
            </div>
          );
        })
      )}
    </div>
  );
}