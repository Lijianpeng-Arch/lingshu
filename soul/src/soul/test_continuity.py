"""测试跨会话主动问候（Continuity）。"""

import gc
import os
import tempfile
import pytest
from soul.continuity import build_continuity_greeting
from soul.memory.long_term import LongTermMemory
from soul.self_model import SelfModel


@pytest.fixture
def mem_dir():
    with tempfile.TemporaryDirectory() as d:
        yield d
    # Windows 上 sqlite3 文件句柄释放需要显式 gc
    gc.collect()


def test_greeting_no_memory_returns_base(mem_dir):
    mem = LongTermMemory(os.path.join(mem_dir, "test.sqlite"))
    sm = SelfModel(name="灵枢", role="AI 助手")
    greeting = build_continuity_greeting(sm, mem)
    assert "灵枢" in greeting
    mem.close()


def test_greeting_recalls_user_name(mem_dir):
    mem = LongTermMemory(os.path.join(mem_dir, "test.sqlite"))
    mem.set("user_name", "九天", tags=["profile"])
    sm = SelfModel(name="灵枢", role="AI 助手")
    greeting = build_continuity_greeting(sm, mem)
    assert "九天" in greeting
    mem.close()


def test_greeting_mentions_last_session(mem_dir):
    mem = LongTermMemory(os.path.join(mem_dir, "test.sqlite"))
    mem.set("last_session_topic", "AI agent 架构", tags=["session"])
    sm = SelfModel(name="灵枢", role="AI 助手")
    greeting = build_continuity_greeting(sm, mem)
    assert "AI agent" in greeting or "上次" in greeting
    mem.close()


def test_greeting_includes_identity(mem_dir):
    mem = LongTermMemory(os.path.join(mem_dir, "test.sqlite"))
    sm = SelfModel(name="灵枢", role="测试角色")
    greeting = build_continuity_greeting(sm, mem)
    assert "灵枢" in greeting
    assert "测试角色" in greeting
    mem.close()
