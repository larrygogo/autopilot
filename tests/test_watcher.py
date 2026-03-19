"""
Watcher 卡死检测测试：is_stuck / recover_task
"""

from datetime import datetime, timedelta, timezone
from unittest import mock

from core.db import create_task, get_conn, get_task
from core.watcher import is_stuck, recover_task


def _create_test_task(task_id="WATCH-001", status="designing"):
    create_task(
        task_id=task_id,
        title="watcher 测试任务",
        workflow="dev",
        channel="log",
        notify_target="",
        req_id="REQ-WATCHER",
        project="test",
        repo_path="/tmp/test",
        branch="feat/test",
    )
    if status != "pending_design":
        conn = get_conn()
        conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, task_id))
    return task_id


class TestIsStuck:
    """卡死检测"""

    def test_locked_not_stuck(self):
        """有锁文件时不算卡死"""
        tid = _create_test_task(status="designing")
        task = get_task(tid)
        with mock.patch("core.watcher.is_locked", return_value=True):
            assert not is_stuck(task)

    def test_timeout_is_stuck(self):
        """超时且无锁时算卡死"""
        tid = _create_test_task(status="designing")
        old_time = (datetime.now(timezone.utc) - timedelta(seconds=1200)).isoformat()
        conn = get_conn()
        conn.execute("UPDATE tasks SET started_at = ? WHERE id = ?", (old_time, tid))
        task = get_task(tid)
        with mock.patch("core.watcher.is_locked", return_value=False):
            assert is_stuck(task)

    def test_terminal_not_stuck(self):
        """终态任务不算卡死"""
        tid = _create_test_task(task_id="WATCH-TERM", status="cancelled")
        task = get_task(tid)
        with mock.patch("core.watcher.is_locked", return_value=False):
            assert not is_stuck(task)

    def test_recently_started_not_stuck(self):
        """刚启动的任务不算卡死"""
        tid = _create_test_task(task_id="WATCH-FRESH", status="designing")
        recent_time = (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()
        conn = get_conn()
        conn.execute("UPDATE tasks SET started_at = ? WHERE id = ?", (recent_time, tid))
        task = get_task(tid)
        with mock.patch("core.watcher.is_locked", return_value=False):
            assert not is_stuck(task)


class TestRecoverTask:
    """恢复任务"""

    def test_recovery_increments_failure_count(self):
        """恢复时 failure_count 递增"""
        tid = _create_test_task(task_id="WATCH-REC", status="designing")
        task = get_task(tid)
        with (
            mock.patch("core.watcher.execute_phase"),
            mock.patch("core.watcher.is_locked", return_value=False),
        ):
            recover_task(task)
        task = get_task(tid)
        assert task["failure_count"] == 1

    def test_max_retries_notifies(self):
        """达到 max_retries 后通知不重试"""
        tid = _create_test_task(task_id="WATCH-MAX", status="designing")
        # 设置 failure_count 已经很高
        conn = get_conn()
        conn.execute("UPDATE tasks SET failure_count = 2 WHERE id = ?", (tid,))
        task = get_task(tid)
        with (
            mock.patch("core.watcher.notify") as mock_notify,
            mock.patch("core.watcher.execute_phase") as mock_exec,
        ):
            recover_task(task)
        # 应该通知而不是重新执行
        assert mock_notify.called
        assert not mock_exec.called
