"""测试长期记忆：SQLite 持久化 key-value + 标签检索。"""

import gc
import os
import tempfile
import pytest
from soul.memory.long_term import LongTermMemory


@pytest.fixture
def db_path():
    with tempfile.TemporaryDirectory() as d:
        yield os.path.join(d, "test.sqlite")
    # Windows 上 sqlite3 文件句柄释放需要显式 gc
    gc.collect()


def test_set_and_get(db_path):
    mem = LongTermMemory(db_path)
    mem.set("user_name", "九天", tags=["profile"])
    assert mem.get("user_name") == "九天"
    mem.close()


def test_get_unknown_returns_none(db_path):
    mem = LongTermMemory(db_path)
    assert mem.get("nope") is None
    mem.close()


def test_update_overwrites(db_path):
    mem = LongTermMemory(db_path)
    mem.set("k", "v1")
    mem.set("k", "v2")
    assert mem.get("k") == "v2"
    mem.close()


def test_search_by_tag(db_path):
    mem = LongTermMemory(db_path)
    mem.set("a", "1", tags=["profile"])
    mem.set("b", "2", tags=["preference"])
    mem.set("c", "3", tags=["profile"])
    keys = {item["key"] for item in mem.search_by_tag("profile")}
    assert keys == {"a", "c"}
    # 新结构应包含 tags 字段
    first = mem.search_by_tag("profile")[0]
    assert "tags" in first
    assert first["tags"] == ["profile"]
    mem.close()


def test_search_by_tag_respects_limit(db_path):
    """search_by_tag 必须用 LIMIT 防止全表扫描。"""
    mem = LongTermMemory(db_path)
    for i in range(10):
        mem.set(f"k{i}", str(i), tags=["bulk"])
    results = mem.search_by_tag("bulk", limit=3)
    assert len(results) == 3
    mem.close()


def test_search_by_tag_returns_list_of_dicts(db_path):
    """返回结构应是 list[dict] (key/value/tags),不再扁平化。"""
    mem = LongTermMemory(db_path)
    mem.set("structured", '{"level": 3}', tags=["json-test"])
    results = mem.search_by_tag("json-test")
    assert len(results) == 1
    assert results[0]["key"] == "structured"
    # JSON value 解析回 dict
    assert results[0]["value"] == {"level": 3}
    mem.close()


def test_persistence_across_instances(db_path):
    mem1 = LongTermMemory(db_path)
    mem1.set("k", "persisted")
    mem1.close()
    mem2 = LongTermMemory(db_path)
    assert mem2.get("k") == "persisted"
    mem2.close()
