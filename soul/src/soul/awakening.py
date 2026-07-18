"""Awakening — 启动自探索。

Phase 2: 接 LongTermMemory 拼跨会话问候。
"""

from __future__ import annotations

import os
from soul.self_model import SelfModel
from soul.continuity import build_continuity_greeting


DEFAULT_MEMORY_DB = os.path.expanduser("~/.lingshu/long_term.sqlite")


def run_awakening(self_model: SelfModel, memory_db_path: str | None = None) -> str:
    from soul.memory.long_term import LongTermMemory

    db_path = memory_db_path or DEFAULT_MEMORY_DB
    memory = LongTermMemory(db_path)
    return build_continuity_greeting(self_model, memory)
