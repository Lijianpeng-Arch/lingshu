"""测试 SelfModel 人格。"""

from soul.self_model import SelfModel


def test_identity_line_basic():
    """identity_line 应当包含 name 和 role。"""
    sm = SelfModel(name="灵枢", role="AI 助手")
    line = sm.identity_line()
    assert "灵枢" in line
    assert "AI 助手" in line


def test_self_model_default_name():
    """默认 name 应当是 '灵枢'。"""
    sm = SelfModel(role="...")
    assert sm.name == "灵枢"


def test_self_model_persists_values():
    """set 后能 get 到。"""
    sm = SelfModel(name="灵枢", role="助手")
    sm.set("personality", "温暖、好奇、主动")
    assert sm.get("personality") == "温暖、好奇、主动"


def test_self_model_get_unknown_returns_none():
    """get 不存在的字段返回 None。"""
    sm = SelfModel(name="灵枢", role="助手")
    assert sm.get("nonexistent") is None


def test_self_model_all_values_returns_copy():
    """set 后 all_values 返回字段副本；修改副本不应影响内部状态。"""
    sm = SelfModel(name="灵枢", role="助手")
    sm.set("personality", "温暖、好奇")
    values = sm.all_values()
    assert values == {"personality": "温暖、好奇"}
    # 修改返回值不应影响 SelfModel 内部
    values["personality"] = "突变"
    assert sm.get("personality") == "温暖、好奇"


def test_self_model_set_empty_string():
    """set 允许空字符串值；get 应当返回空字符串而非 None。"""
    sm = SelfModel(name="灵枢", role="助手")
    sm.set("placeholder", "")
    assert sm.get("placeholder") == ""
    assert sm.get("placeholder") is not None


def test_self_model_get_empty_when_set_empty():
    """get 返回空字符串：当键存在但值为 '' 时应当返回 ''，不是 None。"""
    sm = SelfModel(name="灵枢", role="助手")
    sm.set("notes", "")
    result = sm.get("notes")
    assert result == ""
    assert isinstance(result, str)


def test_identity_line_long_role_text():
    """identity_line 应原样输出很长的 role 文本。"""
    long_role = (
        "本地 AI Agent / 多 LLM Provider 调度器 / ACUI 自适应卡片 UI / "
        "UACS 信封总线 / Python polyglot 后端 / Electron 桌面外壳"
    )
    sm = SelfModel(name="灵枢", role=long_role)
    line = sm.identity_line()
    assert "灵枢" in line
    assert long_role in line
    assert line.endswith("。")