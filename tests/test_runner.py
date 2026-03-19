"""
Runner 引擎测试：锁竞争、阶段异常、钩子调用顺序
"""

from unittest import mock

from core.db import create_task, get_task
from core.runner import execute_phase


def _create_test_task(task_id="RUN-001"):
    create_task(
        task_id=task_id,
        title="runner 测试任务",
        workflow="dev",
        channel="log",
        notify_target="",
        req_id="REQ-RUNNER",
        project="test",
        repo_path="/tmp/test",
        branch="feat/test",
    )
    return task_id


class TestLockContention:
    """锁竞争场景"""

    def test_skip_when_lock_unavailable(self):
        """无法获取锁时跳过执行"""
        tid = _create_test_task()
        with mock.patch("core.runner.acquire_lock", return_value=None):
            execute_phase(tid, "design")
        # 任务状态不变
        assert get_task(tid)["status"] == "pending_design"

    def test_lock_released_on_success(self):
        """成功执行后释放锁"""
        tid = _create_test_task()
        released = []
        with (
            mock.patch("core.runner.acquire_lock", return_value=mock.MagicMock()),
            mock.patch("core.runner.release_lock", side_effect=lambda t: released.append(t)),
            mock.patch(
                "core.runner._get_phase_config_and_func",
                return_value=({"trigger": "start_design"}, lambda t: None),
            ),
        ):
            execute_phase(tid, "design")
        assert tid in released

    def test_lock_released_on_exception(self):
        """异常时也释放锁"""
        tid = _create_test_task()
        released = []

        def failing_func(task_id):
            raise RuntimeError("boom")

        with (
            mock.patch("core.runner.acquire_lock", return_value=mock.MagicMock()),
            mock.patch("core.runner.release_lock", side_effect=lambda t: released.append(t)),
            mock.patch(
                "core.runner._get_phase_config_and_func",
                return_value=({"trigger": "start_design"}, failing_func),
            ),
            mock.patch("core.runner.notify"),
        ):
            execute_phase(tid, "design")
        assert tid in released


class TestPhaseExceptions:
    """阶段异常处理"""

    def test_failure_count_incremented(self):
        """异常时 failure_count 递增"""
        tid = _create_test_task()

        def failing_func(task_id):
            raise RuntimeError("phase failed")

        with (
            mock.patch("core.runner.acquire_lock", return_value=mock.MagicMock()),
            mock.patch("core.runner.release_lock"),
            mock.patch(
                "core.runner._get_phase_config_and_func",
                return_value=({"trigger": "start_design"}, failing_func),
            ),
            mock.patch("core.runner.notify"),
        ):
            execute_phase(tid, "design")
        assert get_task(tid)["failure_count"] == 1

    def test_nonexistent_task_handled(self):
        """不存在的 task 不会崩溃"""
        with (
            mock.patch("core.runner.acquire_lock", return_value=mock.MagicMock()),
            mock.patch("core.runner.release_lock"),
        ):
            execute_phase("NONEXISTENT", "design")
        # 无异常即通过


class TestHookInvocationOrder:
    """钩子调用顺序"""

    def test_before_phase_after_order(self):
        """before → phase → after 顺序"""
        tid = _create_test_task()
        call_order = []

        def mock_before(task_id, phase):
            call_order.append("before")

        def mock_after(task_id, phase):
            call_order.append("after")

        def mock_phase_func(task_id):
            call_order.append("phase")

        with (
            mock.patch("core.runner.acquire_lock", return_value=mock.MagicMock()),
            mock.patch("core.runner.release_lock"),
            mock.patch(
                "core.runner._get_phase_config_and_func",
                return_value=({"trigger": "start_design"}, mock_phase_func),
            ),
            mock.patch(
                "core.runner._invoke_hook",
                side_effect=lambda task, hook_name, phase, error=None: (
                    call_order.append("before")
                    if hook_name == "before_phase"
                    else call_order.append("after")
                    if hook_name == "after_phase"
                    else None
                ),
            ),
        ):
            execute_phase(tid, "design")

        assert call_order == ["before", "phase", "after"]
