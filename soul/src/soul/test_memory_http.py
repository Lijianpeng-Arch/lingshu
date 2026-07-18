"""Memory HTTP 端点测试。

Task 3.2: 验证 /memory/append + /memory/query。
- POST /memory/append { kind, content, tags? } → { id }
- GET  /memory/query?q=...&limit=N       → [{ id, content, score }]
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from soul.api import app
import soul.api as api_module


@pytest.fixture
def client(monkeypatch):
    """用临时库隔离单例,避免污染用户数据。D5: 同时注入 Bearer token。"""
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "test_memory.db"
        monkeypatch.setenv("LINGSHU_SOUL_DB", str(db))
        # 重置模块级单例,确保新路径生效
        api_module._mem = None
        # D5: 注入固定 token 给所有调用
        api_module._SOUL_TOKEN = "test-memory-http-token"
        headers = {"authorization": f"Bearer {api_module._SOUL_TOKEN}"}
        c = TestClient(app)
        yield c, headers
        api_module._mem = None


def test_memory_append_returns_id(client) -> None:
    c, headers = client
    r = c.post(
        "/memory/append",
        json={"kind": "fact", "content": "用户喜欢广州", "tags": ["偏好"]},
        headers=headers,
    )
    assert r.status_code == 200
    assert "id" in r.json()


def test_memory_query_returns_results(client) -> None:
    c, headers = client
    c.post(
        "/memory/append",
        json={"kind": "fact", "content": "用户在北京工作"},
        headers=headers,
    )
    r = c.get("/memory/query", params={"q": "北京", "limit": 5}, headers=headers)
    assert r.status_code == 200
    results = r.json()
    assert len(results) >= 1
    assert any("北京" in item["content"] for item in results)
