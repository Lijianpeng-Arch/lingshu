"""测试短期记忆：FIFO 队列，超过 max_turns 自动丢弃最早消息。"""

from soul.memory.short_term import ShortTermMemory, ShortTermMessage


def test_add_and_get_messages():
    """添加消息后 all() 应按插入顺序返回。"""
    mem = ShortTermMemory(max_turns=5)
    mem.add(ShortTermMessage(role="user", content="hi"))
    mem.add(ShortTermMessage(role="assistant", content="hello"))

    msgs = mem.all()
    assert len(msgs) == 2
    assert msgs[0].role == "user"
    assert msgs[0].content == "hi"
    assert msgs[1].role == "assistant"
    assert msgs[1].content == "hello"


def test_max_turns_drops_oldest():
    """超过 max_turns 应丢弃最早消息（FIFO）。"""
    mem = ShortTermMemory(max_turns=3)
    for i in range(5):
        mem.add(ShortTermMessage(role="user", content=f"msg-{i}"))

    msgs = mem.all()
    assert len(msgs) == 3
    assert [m.content for m in msgs] == ["msg-2", "msg-3", "msg-4"]


def test_clear_empties_memory():
    """clear() 后 all() 应返回空列表。"""
    mem = ShortTermMemory(max_turns=10)
    mem.add(ShortTermMessage(role="user", content="hi"))
    mem.clear()

    assert mem.all() == []


def test_short_term_message_has_timestamp():
    """ShortTermMessage 应自动生成 timestamp。"""
    from datetime import datetime

    msg = ShortTermMessage(role="user", content="hi")
    assert isinstance(msg.timestamp, datetime)


def test_default_max_turns_is_20():
    """默认 max_turns 应当是 20。"""
    mem = ShortTermMemory()
    assert mem.max_turns == 20
