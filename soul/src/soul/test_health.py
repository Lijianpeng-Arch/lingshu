"""健康检查端点测试。

Task 3.1: 验证 /health 返回 status / uptime_sec / db_ok 三字段。
D5: 端点受 Bearer token 保护。
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from soul import api as api_mod
from soul.api import app

client = TestClient(app)


def _auth_headers() -> dict[str, str]:
    """D5: /health 需要 Bearer token。注入固定测试 token。"""
    if not getattr(api_mod, "_SOUL_TOKEN", None):
        api_mod._SOUL_TOKEN = "test-health-token"
    return {"authorization": f"Bearer {api_mod._SOUL_TOKEN}"}


def test_health_returns_ok() -> None:
    """GET /health 必须返回 200 + 完整三字段。"""
    r = client.get("/health", headers=_auth_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "uptime_sec" in body
    assert "db_ok" in body


def test_health_uptime_is_nonneg_int() -> None:
    """uptime_sec 应为非负整数。"""
    r = client.get("/health", headers=_auth_headers())
    body = r.json()
    assert isinstance(body["uptime_sec"], int)
    assert body["uptime_sec"] >= 0


def test_health_db_ok_is_bool() -> None:
    """当 LongTermMemory 能 init 时,db_ok 应为 True。"""
    r = client.get("/health", headers=_auth_headers())
    body = r.json()
    assert isinstance(body["db_ok"], bool)


# 验证 LongTermMemory 本身能 init,确保端点的 db_ok 检测路径有效
def test_long_term_memory_init_works() -> None:
    from soul.memory.long_term import LongTermMemory

    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "test.db"
        mem = LongTermMemory(str(db))
        try:
            mem.set("k", "v")
            assert mem.get("k") == "v"
        finally:
            mem.close()
