"""Continuity — 跨会话主动问候。"""

from __future__ import annotations

from soul.memory.long_term import LongTermMemory
from soul.self_model import SelfModel


def build_continuity_greeting(
    self_model: SelfModel,
    memory: LongTermMemory,
    user_name: str | None = None,
) -> str:
    parts: list[str] = [self_model.identity_line()]
    recalled_name = user_name or memory.get("user_name")
    if recalled_name:
        parts.append(f"{recalled_name}，很高兴又见面。")
    last_topic = memory.get("last_session_topic")
    if last_topic:
        parts.append(f"上次我们聊到「{last_topic}」，要继续吗？")
    unfinished = memory.search_by_tag("task")
    unfinished_keys = [k for k in unfinished if not unfinished[k].startswith("done:")]
    if unfinished_keys:
        parts.append(f"还有 {len(unfinished_keys)} 件事没做完。")
    if len(parts) == 1:
        parts.append("我已就绪。")
    return " ".join(parts)
