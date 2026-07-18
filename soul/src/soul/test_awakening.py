"""测试启动自探索（Awakening）。"""

from soul.awakening import run_awakening
from soul.self_model import SelfModel


def test_run_awakening_returns_string():
    """返回的应当是非空字符串。"""
    sm = SelfModel(name="灵枢", role="AI 助手")
    greeting = run_awakening(self_model=sm)
    assert isinstance(greeting, str)
    assert len(greeting) > 0


def test_run_awakening_includes_identity():
    """启动问候应包含身份信息。"""
    sm = SelfModel(name="灵枢", role="测试角色")
    greeting = run_awakening(self_model=sm)
    assert "灵枢" in greeting


def test_run_awakening_deterministic():
    """同样输入应该返回同样问候（Phase 1 stub 行为）。"""
    sm = SelfModel(name="灵枢", role="助手")
    g1 = run_awakening(self_model=sm)
    g2 = run_awakening(self_model=sm)
    assert g1 == g2