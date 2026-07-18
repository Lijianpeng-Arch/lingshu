"""并发访问测试：threading.Lock + check_same_thread=False。

LongTermMemory 内部用 threading.Lock 串行化所有 SQLite 操作。
本文件验证在多线程并发场景下:
1. 写入不丢不重。
2. 读写同时进行不出异常。
3. 锁确实在工作(串行化会让并发总耗时 > 顺序/单次耗时)。
"""

from __future__ import annotations

import gc
import os
import tempfile
import threading
import time

import pytest

from soul.memory.long_term import LongTermMemory


@pytest.fixture
def db_path():
    with tempfile.TemporaryDirectory() as d:
        yield os.path.join(d, "concurrency.sqlite")
    # Windows 上 sqlite3 文件句柄释放需要显式 gc
    gc.collect()


# ---------------------------------------------------------------------------
# Test 1: Concurrent add — 50 个 add 调用,ID 全唯一、总条数 == 50
# ---------------------------------------------------------------------------

def test_concurrent_add_unique_ids_and_total_count(db_path):
    """10 线程 × 5 次 append = 50 条,全部 ID 唯一,最终可见条数 == 50。"""
    mem = LongTermMemory(db_path)
    try:
        N_THREADS = 10
        N_PER_THREAD = 5

        all_ids: list[str] = []
        all_ids_lock = threading.Lock()

        def worker(tag: str) -> None:
            thread_ids: list[str] = []
            for i in range(N_PER_THREAD):
                mem_id = mem.append(f"content-{tag}-{i}", kind="fact", tags=[tag])
                thread_ids.append(mem_id)
            with all_ids_lock:
                all_ids.extend(thread_ids)

        threads = [
            threading.Thread(target=worker, args=(f"t{i}",))
            for i in range(N_THREADS)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # ID 必须全唯一(append 内部用 uuid4,锁保证不会撞)
        assert len(all_ids) == N_THREADS * N_PER_THREAD
        assert len(set(all_ids)) == len(all_ids), "duplicate IDs detected"

        # 最终可见条数:用 query 扫全表(LIMIT 默认)
        all_rows = mem.query("content-", limit=10_000)
        assert len(all_rows) == N_THREADS * N_PER_THREAD
        # 每条都应该在 all_ids 里出现过
        all_id_set = set(all_ids)
        assert {r["id"] for r in all_rows} == all_id_set
    finally:
        mem.close()


# ---------------------------------------------------------------------------
# Test 2: 1 个写线程 + 3 个读线程同时跑,读线程不抛异常、读到的都是有效数据
# ---------------------------------------------------------------------------

def test_concurrent_read_during_write(db_path):
    """写线程循环写入,3 个读线程同时 query,应全程无异常、无脏读。"""
    mem = LongTermMemory(db_path)
    try:
        N_WRITES = 100
        READER_COUNT = 3
        READER_ITERATIONS = 30

        stop_write = threading.Event()
        write_errors: list[BaseException] = []
        read_errors: list[BaseException] = []

        def writer() -> None:
            try:
                for i in range(N_WRITES):
                    mem.append(f"write-{i}", kind="fact", tags=["stream"])
            except BaseException as e:  # noqa: BLE001
                write_errors.append(e)
            finally:
                stop_write.set()

        def reader(_reader_id: int) -> None:
            try:
                for _ in range(READER_ITERATIONS):
                    rows = mem.query("write-", limit=50)
                    # 读到的每一条都必须是有效 dict,且 content 是字符串
                    for row in rows:
                        assert isinstance(row, dict)
                        assert "id" in row and "content" in row
                        assert isinstance(row["content"], str)
                        assert row["content"].startswith("write-")
            except BaseException as e:  # noqa: BLE001
                read_errors.append(e)

        write_thread = threading.Thread(target=writer)
        reader_threads = [
            threading.Thread(target=reader, args=(i,))
            for i in range(READER_COUNT)
        ]

        write_thread.start()
        for t in reader_threads:
            t.start()
        write_thread.join()
        for t in reader_threads:
            t.join()

        assert not write_errors, f"writer crashed: {write_errors}"
        assert not read_errors, f"reader crashed: {read_errors}"

        # 最终 N_WRITES 条数据全部落盘且可读
        final = mem.query("write-", limit=10_000)
        assert len(final) == N_WRITES
    finally:
        mem.close()


# ---------------------------------------------------------------------------
# Test 3: 锁串行化可观察 — 10 个并发写的总耗时 >= 单次顺序写的 2 倍
# ---------------------------------------------------------------------------

def test_lock_serializes_writes(db_path):
    """锁必须真正生效。

    单个写 50 次(顺序)的基线耗时 * 2 <= 并发 10 线程各 50 次的总耗时。
    理论上 10×50=500 次写,串行总耗时 ≈ (单写耗时 × 500);
    并发版本里锁串行化,总耗时也应 ≈ (单写耗时 × 500),
    所以它们大致相当。我们只要求并发总耗时远高于"无锁理想值"
    (10 线程并发最坏情况 ≈ 单写 × 50,即理想无锁加速比 10x),
    因此断言:并发总耗时 >= 2 × 单线程 50 次耗时,足以说明串行化生效。
    """
    # 基线:单线程顺序 50 次
    base_mem = LongTermMemory(db_path)
    try:
        t0 = time.perf_counter()
        for i in range(50):
            base_mem.append(f"base-{i}", kind="fact", tags=["baseline"])
        sequential_time = time.perf_counter() - t0
    finally:
        base_mem.close()

    # 新实例(同一文件,但 db_path 隔离同一 fixture)
    # 用一个独立 db 来避免互相干扰 — 借用同 fixture 的临时目录
    import os as _os
    concurrent_db = _os.path.join(_os.path.dirname(db_path), "concurrency_serial.sqlite")

    conc_mem = LongTermMemory(concurrent_db)
    try:
        N_THREADS = 10
        N_PER_THREAD = 50
        barrier = threading.Barrier(N_THREADS)

        def worker() -> None:
            # 所有线程在 barrier 处汇合,几乎同时开跑 → 制造最大化竞争
            barrier.wait()
            for i in range(N_PER_THREAD):
                conc_mem.append(f"c-{threading.get_ident()}-{i}", kind="fact", tags=["c"])

        threads = [
            threading.Thread(target=worker) for _ in range(N_THREADS)
        ]
        t0 = time.perf_counter()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        concurrent_time = time.perf_counter() - t0
    finally:
        conc_mem.close()

    # 锁串行化生效:10 线程并发总耗时 至少 是 单线程顺序同量级工作 的 2 倍。
    # 理想无锁并发的总耗时应 <= sequential_time(单线程 50 次基线),
    # 实际因为锁是单线程串行执行全部 500 次写,所以 >= sequential_time。
    # 给一个 2x 缓冲容忍测量噪声。
    assert concurrent_time >= 2.0 * sequential_time, (
        f"并发写耗时 {concurrent_time:.3f}s 不够长(基线顺序 50 次 = "
        f"{sequential_time:.3f}s),锁可能未串行化"
    )

    # 顺带验证全部 500 条都落盘,锁没有吃掉任何写入
    verify = LongTermMemory(concurrent_db)
    try:
        rows = verify.query("c-", limit=10_000)
        assert len(rows) == N_THREADS * N_PER_THREAD
    finally:
        verify.close()
