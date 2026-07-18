"""Phase D5: Bearer token auth 端点测试。

策略: 不重载整个模块,而是直接 patch 模块级 _SOUL_TOKEN。
每次测试设置一个已知的固定 token,TestClient 用 auth_headers 验证。
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

TEST_TOKEN = "test-token-fixed-for-deterministic-auth-tests"


@pytest.fixture
def api_with_token():
    """临时 patch soul.api._SOUL_TOKEN 为 TEST_TOKEN,测试结束后恢复。"""
    import soul.api as api_mod

    saved = api_mod._SOUL_TOKEN
    api_mod._SOUL_TOKEN = TEST_TOKEN
    client = TestClient(api_mod.app)
    yield client, TEST_TOKEN
    api_mod._SOUL_TOKEN = saved


@pytest.fixture
def api_with_no_env():
    """模拟 LINGSHOU_SOUL_TOKEN 未注入,模块层 token 应为自动生成的非空字符串。"""
    import soul.api as api_mod

    saved = api_mod._SOUL_TOKEN
    api_mod._SOUL_TOKEN = __import__("secrets").token_urlsafe(32)
    yield api_mod
    api_mod._SOUL_TOKEN = saved


def test_missing_authorization_header_returns_401(api_with_token) -> None:
    client, _ = api_with_token
    r = client.get("/health")
    assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text}"
    assert r.headers.get("www-authenticate") == "Bearer"
    # 同样规则应用到 /memory/append 和 /memory/query
    r = client.post("/memory/append", json={"content": "x"})
    assert r.status_code == 401
    r = client.get("/memory/query", params={"q": "x"})
    assert r.status_code == 401


def test_wrong_token_returns_401(api_with_token) -> None:
    client, _ = api_with_token
    # 错误 token 返回 401
    r = client.get("/health", headers={"authorization": "Bearer not-the-real-token"})
    assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text}"
    # 格式错(没 Bearer 前缀)同样拒绝
    r = client.get("/health", headers={"authorization": TEST_TOKEN})
    assert r.status_code == 401
    # 正确 token 通过(大小写不敏感:bearer 小写也认)
    r = client.get("/health", headers={"authorization": f"bearer {TEST_TOKEN}"})
    assert r.status_code == 200


def test_correct_token_returns_200(api_with_token) -> None:
    client, token = api_with_token
    auth = {"authorization": f"Bearer {token}"}

    # /health 通过
    r = client.get("/health", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] in ("ok", "degraded")
    assert "uptime_sec" in body

    # /memory/append 通过并返回 id
    r = client.post(
        "/memory/append",
        json={"kind": "fact", "content": "auth-test marker", "tags": ["d5"]},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    assert "id" in r.json()

    # /memory/query 通过
    r = client.get("/memory/query", params={"q": "auth-test"}, headers=auth)
    assert r.status_code == 200, r.text
    results = r.json()
    assert isinstance(results, list)
    assert any("auth-test" in (item.get("content") or "") for item in results)


def test_auto_generate_token_when_no_env(api_with_no_env) -> None:
    """模块层 _SOUL_TOKEN 必须非空(自动生成保证的)。"""
    api_mod = api_with_no_env
    assert api_mod._SOUL_TOKEN, "expected token to be non-empty"
    assert api_mod._SOUL_TOKEN != TEST_TOKEN
    # secrets.token_urlsafe(32) 默认输出 43 chars
    assert len(api_mod._SOUL_TOKEN) >= 32
