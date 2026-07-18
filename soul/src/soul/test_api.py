"""测试 FastAPI 入口和 /health 端点。"""

from fastapi.testclient import TestClient


def _auth_headers() -> dict[str, str]:
    """D5: 所有受保护端点都需要 Bearer token。"""
    from soul import api as api_mod

    if not getattr(api_mod, "_SOUL_TOKEN", None):
        api_mod._SOUL_TOKEN = "test-api-token"
    return {"authorization": f"Bearer {api_mod._SOUL_TOKEN}"}


def test_health_endpoint_returns_ok():
    """GET /health 应该返回 status=ok + uptime_sec + db_ok。"""
    from soul.api import app

    client = TestClient(app)
    response = client.get("/health", headers=_auth_headers())

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "uptime_sec" in body
    assert "db_ok" in body


def test_app_title_is_lingshu_soul():
    """FastAPI app 的 title 应当是 '灵枢 AI 核心'。"""
    from soul.api import app

    assert "灵枢" in app.title
