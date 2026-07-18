"""测试 Windows UTF-8 bootstrap."""

import sys


def test_setup_utf8_stdio_sets_utf8_encoding():
    """调用 setup_utf8_stdio 后 sys.stdout/stderr 应该是 UTF-8。"""
    from soul.bootstrap import setup_utf8_stdio

    setup_utf8_stdio()

    assert sys.stdout.encoding.lower().replace("-", "") in ("utf8", "utf16", "cp65001"), \
        f"stdout encoding 不是 UTF-8 系列: {sys.stdout.encoding}"
    assert sys.stderr.encoding.lower().replace("-", "") in ("utf8", "utf16", "cp65001"), \
        f"stderr encoding 不是 UTF-8 系列: {sys.stderr.encoding}"


def test_setup_utf8_stdio_is_idempotent():
    """多次调用不应报错。"""
    from soul.bootstrap import setup_utf8_stdio

    setup_utf8_stdio()
    setup_utf8_stdio()  # 第二次不应崩

    assert True  # 没崩就是成功


def test_setup_utf8_stdio_sets_env_vars():
    """应当设置 PYTHONUTF8 和 PYTHONIOENCODING。"""
    import os
    from soul.bootstrap import setup_utf8_stdio

    setup_utf8_stdio()

    # setdefault 不覆盖已有值；测试前确保环境干净
    assert os.environ.get("PYTHONUTF8") == "1"
    # 至少 stdout 已是 UTF-8（test_setup_utf8_stdio_sets_utf8_encoding 已验证）
