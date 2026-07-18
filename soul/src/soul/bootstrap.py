"""Windows UTF-8 stdio bootstrap。

解决 Windows 下 Python 默认 stdio 是 cp1252 导致中文乱码的问题。
POSIX 系统上是 no-op。
任何入口点（api.py、CLI）都应该在最顶部导入此模块。
"""

from __future__ import annotations

import os
import sys
from typing import Final

_BOOTSTRAP_DONE: bool = False

_UTF8_ENCODINGS: Final[frozenset[str]] = frozenset({
    "utf-8", "utf8", "cp65001",  # Windows UTF-8 codepage
})


def setup_utf8_stdio() -> None:
    """幂等地设置 stdout/stderr 为 UTF-8 编码。

    - Windows：设置 PYTHONUTF8=1 + PYTHONIOENCODING=utf-8，重配 stdio
    - POSIX：no-op（默认就是 UTF-8）
    - 第二次调用：no-op
    """
    global _BOOTSTRAP_DONE
    if _BOOTSTRAP_DONE:
        return

    if sys.platform == "win32":
        # 用 setdefault 保留用户自定义
        os.environ.setdefault("PYTHONUTF8", "1")
        os.environ.setdefault("PYTHONIOENCODING", "utf-8")

        # 重配现有 stdio 流
        for stream_name in ("stdout", "stderr", "stdin"):
            stream = getattr(sys, stream_name, None)
            if stream is None or not hasattr(stream, "reconfigure"):
                continue
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                # 已关闭的流 / 非标准流 → 静默失败
                pass

    _BOOTSTRAP_DONE = True


# 模块导入即触发（首次）
setup_utf8_stdio()
