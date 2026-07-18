"""SelfModel — 灵枢的人格档案。

Phase 1 实现：内存 dict
Phase 2 实现：持久化到 SQLite
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SelfModel:
    """灵枢的人格档案。

    Attributes:
        name: 名字（默认"灵枢"）
        role: 角色描述
        _values: 自定义键值对（personality / tone / interests 等）
    """

    name: str = "灵枢"
    role: str = "本地 AI Agent"
    _values: dict[str, str] = field(default_factory=dict)

    def identity_line(self) -> str:
        """返回一行自我介绍：'我是 {name}，一个 {role}。'"""
        return f"我是 {self.name}，一个 {self.role}。"

    def set(self, key: str, value: str) -> None:
        """设置自定义字段。"""
        self._values[key] = value

    def get(self, key: str) -> str | None:
        """读取自定义字段；不存在返回 None。"""
        return self._values.get(key)

    def all_values(self) -> dict[str, str]:
        """返回所有自定义字段的副本。"""
        return dict(self._values)