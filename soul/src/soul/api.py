"""灵枢 AI 核心 — FastAPI 入口。

提供：
- GET /health — 健康检查
- POST /chat — 主对话（Phase 1 stub）
- WebSocket /ws — UACS 事件流（Phase 1 stub）
"""

from __future__ import annotations

# 必须最先导入：UTF-8 bootstrap
from soul import bootstrap  # noqa: F401

import time
import os
from pathlib import Path
import tempfile

from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from soul.memory.long_term import LongTermMemory

# D5 auth: Bearer token 鉴权。模块级 _SOUL_TOKEN:
# - 优先读环境变量 LINGSHOU_SOUL_TOKEN(注入部署用)
# - 缺失则用 secrets.token_urlsafe(32) 自动生成(本地开发 + 测试 fixture 用)
# 测试通过 monkeypatch api_mod._SOUL_TOKEN 注入固定 token。
import secrets
_SOUL_TOKEN = os.environ.get("LINGSHOU_SOUL_TOKEN") or secrets.token_urlsafe(32)

# FastAPI HTTPBearer 安全 scheme — auto_error=False 让缺 header 时我们手动返回 401
_bearer_scheme = HTTPBearer(auto_error=False)


def _require_bearer(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> str:
    """FastAPI 依赖: 验证 Authorization: Bearer <token>,失败抛 401。

    Token 大小写不敏感(bearer / Bearer 都认),header 缺失或 token 不对 → 401。
    """
    if creds is None or not creds.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if creds.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid auth scheme",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if creds.credentials != _SOUL_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return creds.credentials

app = FastAPI(
    title="灵枢 V2 — Python AI Core",
    description="Lingshu V2 Python sidecar — 3 层记忆 + SelfModel + Continuity",
    version="0.1.0",
)

# 进程启动时间戳 — 用于 /health 计算 uptime_sec
_START_TIME = time.time()

# 模块级 LongTermMemory 单例 — /memory/* 端点共享,进程内保持状态。
# 数据落盘到 ~/.lingshu/soul_memory.db(与 Electron 侧约定的用户数据目录一致)。
# 懒加载:首次访问端点时才建连,避免 import 期做 IO。
_mem: LongTermMemory | None = None


def _get_memory() -> LongTermMemory:
    """获取模块级 LongTermMemory 单例(懒加载 + 幂等)。

    db 路径可用环境变量 LINGSHU_SOUL_DB 覆盖(测试用临时库,避免污染用户数据)。
    """
    global _mem
    if _mem is None:
        override = os.environ.get("LINGSHU_SOUL_DB")
        db_path = Path(override) if override else Path.home() / ".lingshu" / "soul_memory.db"
        _mem = LongTermMemory(str(db_path))
    return _mem


@app.get("/health")
async def health(_token: str = Depends(_require_bearer)) -> dict:
    """健康检查端点。

    返回字段:
    - status: 'ok' | 'degraded'
    - uptime_sec: 进程启动至今秒数 (int)
    - db_ok: LongTermMemory 能否成功初始化
    """
    db_ok = True
    try:
        # 测试 long_term 能 init — 用 tempfile 避免污染用户目录
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "_health_check.db"
            mem = LongTermMemory(str(db_path))
            mem.close()
    except Exception:
        db_ok = False

    return {
        "status": "ok" if db_ok else "degraded",
        "uptime_sec": int(time.time() - _START_TIME),
        "db_ok": db_ok,
    }


# Phase 2 才实施真实端点；Phase 1 保留 stub
# M11 review: 用 Pydantic 限长,防 body 炸弹
class ChatRequest(BaseModel):
    message: str = Field(..., max_length=10_000)
    session_id: str | None = Field(None, max_length=128)


@app.post("/chat")
async def chat_stub(req: ChatRequest) -> dict[str, str]:
    """对话端点 stub（Phase 2 实施）。"""
    return {"status": "stub", "echo": req.message[:100]}


# ── Memory HTTP 端点 (Task 3.2) ──────────────────────────────────────────
# backend 通过这两个端点读写长期记忆。
# M11 review 同款做法:用 Pydantic 限长,防 body 炸弹。
class MemoryAppendRequest(BaseModel):
    kind: str = Field("fact", max_length=64)
    content: str = Field(..., max_length=10_000)
    tags: list[str] = Field(default_factory=list, max_length=32)


@app.post("/memory/append")
async def memory_append(req: MemoryAppendRequest, _token: str = Depends(_require_bearer)) -> dict[str, str]:
    """追加一条记忆,返回 { id }。"""
    mem_id = _get_memory().append(content=req.content, kind=req.kind, tags=req.tags)
    return {"id": mem_id}


@app.get("/memory/query")
async def memory_query(q: str, limit: int = 10, _token: str = Depends(_require_bearer)) -> list[dict]:
    """按内容检索记忆,返回 [{ id, content, score }]。"""
    # 限制 limit 上界,防一次性拉全表
    safe_limit = max(1, min(limit, 100))
    return _get_memory().query(q=q, limit=safe_limit)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7777)
