"""长期记忆：SQLite 持久化 key-value + 标签检索。

Phase 1: 简单 KV
Phase 2: 加 sqlite-vec + FTS5 + 时态解析
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Optional


class LongTermMemory:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False: 允许跨线程复用同一连接
        # (FastAPI 把同步端点丢到 threadpool 执行,模块级单例会被多线程访问)。
        # 用 _lock 串行化所有访问,保证 check_same_thread=False 下依然线程安全。
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._lock = threading.Lock()
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS long_term_memory (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    tags TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
            """)
            self._conn.commit()

    def set(self, key: str, value: str, tags: Optional[list[str]] = None) -> None:
        now = int(time.time() * 1000)
        tags_json = json.dumps(tags or [])
        with self._lock:
            self._conn.execute(
                """INSERT INTO long_term_memory (key, value, tags, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value, tags = excluded.tags, updated_at = excluded.updated_at
                """,
                (key, value, tags_json, now, now),
            )
            self._conn.commit()

    def get(self, key: str) -> Optional[str]:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM long_term_memory WHERE key = ?", (key,)
            ).fetchone()
        return row[0] if row else None

    def search_by_tag(self, tag: str, limit: int = 100) -> list[dict]:
        """按标签检索;限制结果数量避免一次性加载全表。

        返回 list[dict] (含 key/value/tags),便于调用方拿到完整结构
        (原 dict[str,str] 接口扁平化,丢了 tags 信息)。
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT key, value, tags FROM long_term_memory LIMIT ?",
                (limit,),
            ).fetchall()
        results: list[dict] = []
        for row in rows:
            # row_factory 未设置,默认 tuple
            row_key, row_value, row_tags = row[0], row[1], row[2]
            try:
                tags = json.loads(row_tags) if row_tags else []
            except (json.JSONDecodeError, TypeError):
                continue
            if tag in tags:
                try:
                    value = json.loads(row_value)
                except (json.JSONDecodeError, TypeError):
                    value = row_value
                results.append({"key": row_key, "value": value, "tags": tags})
        return results

    def append(
        self, content: str, kind: str = "fact", tags: Optional[list[str]] = None
    ) -> str:
        """追加一条记忆,自动生成唯一 id 作为 key。

        与 set() 不同:set() 是按调用方给定 key 的 upsert(覆盖语义),
        append() 面向"不断累积的记忆条目"场景,每次都新建一条。

        kind 作为标签一并写入(tags = [kind] + tags),便于 search_by_tag 复用。
        返回新记忆的 id。
        """
        mem_id = uuid.uuid4().hex
        all_tags = [kind] + list(tags or [])
        self.set(mem_id, content, tags=all_tags)
        return mem_id

    def query(self, q: str, limit: int = 10) -> list[dict]:
        """按内容子串检索记忆,返回 [{id, content, score}]。

        Phase 1 极简实现:子串匹配 + 朴素打分(命中次数 / 内容长度),
        分数越高越相关。Phase 2 再换 FTS5 / 向量检索。
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT key, value FROM long_term_memory"
            ).fetchall()
        results: list[dict] = []
        for row in rows:
            row_key, row_value = row[0], row[1]
            # value 可能是 JSON 编码的字符串,也可能是裸字符串
            try:
                content = json.loads(row_value)
            except (json.JSONDecodeError, TypeError):
                content = row_value
            if not isinstance(content, str):
                content = str(content)
            if q and q in content:
                # 朴素打分:命中次数越多、内容越短,越相关
                hits = content.count(q)
                score = hits / max(len(content), 1)
                results.append({"id": row_key, "content": content, "score": score})
        results.sort(key=lambda item: item["score"], reverse=True)
        return results[:limit]

    def close(self) -> None:
        """关闭数据库连接（Windows 上需要显式关闭以释放文件锁）。"""
        if self._conn is None:
            return
        try:
            self._conn.close()
        except Exception:
            pass  # 连接可能已关闭,静默
        self._conn = None

    def __enter__(self) -> "LongTermMemory":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def __del__(self) -> None:
        # 不吞异常 — 让 GC 看到,避免真正出错时被掩盖。
        # 已通过 close() 内部幂等保证不会重复关闭。
        self.close()
