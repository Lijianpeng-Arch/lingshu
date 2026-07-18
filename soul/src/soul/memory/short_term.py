"""短期记忆：当前会话消息队列，FIFO，超限自动丢弃最早消息。

Phase 1 实现：
- 内存 deque
- max_turns 默认 20
- add/all/clear 三个方法

Phase 2 加：
- token 计数（超 token 上限也压缩）
- 重要性评分（重要消息保留）
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal


@dataclass
class ShortTermMessage:
    """短期记忆中的单条消息。"""

    role: Literal["system", "user", "assistant", "tool"]
    content: str
    timestamp: datetime = field(default_factory=datetime.now)
    name: str | None = None  # tool name 等


class ShortTermMemory:
    """FIFO 短期记忆队列。"""

    DEFAULT_MAX_TURNS = 20

    def __init__(self, max_turns: int = DEFAULT_MAX_TURNS) -> None:
        if max_turns <= 0:
            raise ValueError(f"max_turns must be > 0, got {max_turns}")
        self.max_turns = max_turns
        self._messages: deque[ShortTermMessage] = deque(maxlen=max_turns)

    def add(self, message: ShortTermMessage) -> None:
        """添加一条消息；超过 max_turns 自动丢弃最早消息。"""
        self._messages.append(message)

    def all(self) -> list[ShortTermMessage]:
        """按插入顺序返回所有消息的副本。"""
        return list(self._messages)

    def clear(self) -> None:
        """清空所有消息。"""
        self._messages.clear()

    def __len__(self) -> int:
        return len(self._messages)
