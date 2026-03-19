"""
事件/钩子系统单元测试
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

from core.db import create_task, get_task
from core.registry import _registry, register, validate_workflow
from core.runner import _invoke_hook, execute_phase


def _dummy_func(task_id: str) -> None:
    pass


def _make_hook_workflow(hooks: dict | None = None, phase_func=None) -> SimpleNamespace:
    """创建带钩子的测试工作流"""
    wf = {
        "name": "test_hooks_wf",
        "description": "钩子测试工作流",
        "phases": [
            {
                "name": "step1",
                "pending_state": "pending_step1",
                "running_state": "running_step1",
                "trigger": "start_step1",
                "complete_trigger": "step1_done",
                "func": phase_func or _dummy_func,
            },
        ],
        "initial_state": "pending_step1",
        "terminal_states": ["done", "cancelled"],
        "transitions": {
            "pending_step1": [("start_step1", "running_step1"), ("cancel", "cancelled")],
            "running_step1": [("step1_done", "done"), ("cancel", "cancelled")],
        },
    }
    if hooks is not None:
        wf["hooks"] = hooks
    return SimpleNamespace(WORKFLOW=wf)


def _create_test_task(
    task_id: str = "hook_test_1", workflow: str = "test_hooks_wf", status: str = "pending_step1"
) -> None:
    create_task(
        task_id=task_id,
        title="Hook Test",
        workflow=workflow,
        channel="log",
        notify_target="",
        initial_status=status,
        req_id="REQ-HOOK",
        project="test",
        repo_path="/tmp/repo",
        branch="feat/hook",
    )


class TestInvokeHook:
    """_invoke_hook 直接调用测试"""

    def test_before_phase_called(self):
        callback = mock.Mock()
        mod = _make_hook_workflow(hooks={"before_phase": callback})
        register(mod)
        try:
            _create_test_task()
            task = get_task("hook_test_1")
            _invoke_hook(task, "before_phase", "step1")
            callback.assert_called_once_with("hook_test_1", "step1")
        finally:
            _registry.pop("test_hooks_wf", None)

    def test_after_phase_called(self):
        callback = mock.Mock()
        mod = _make_hook_workflow(hooks={"after_phase": callback})
        register(mod)
        try:
            _create_test_task()
            task = get_task("hook_test_1")
            _invoke_hook(task, "after_phase", "step1")
            callback.assert_called_once_with("hook_test_1", "step1")
        finally:
            _registry.pop("test_hooks_wf", None)

    def test_on_phase_error_called_with_error(self):
        callback = mock.Mock()
        mod = _make_hook_workflow(hooks={"on_phase_error": callback})
        register(mod)
        try:
            _create_test_task()
            task = get_task("hook_test_1")
            err = RuntimeError("test error")
            _invoke_hook(task, "on_phase_error", "step1", err)
            callback.assert_called_once_with("hook_test_1", "step1", err)
        finally:
            _registry.pop("test_hooks_wf", None)

    def test_no_hooks_silent_skip(self):
        """无 hooks 字段时静默跳过"""
        mod = _make_hook_workflow(hooks=None)
        register(mod)
        try:
            _create_test_task()
            task = get_task("hook_test_1")
            # 不应抛异常
            _invoke_hook(task, "before_phase", "step1")
        finally:
            _registry.pop("test_hooks_wf", None)

    def test_hook_exception_does_not_propagate(self):
        """钩子抛异常不中断主流程"""

        def bad_hook(task_id, phase):
            raise ValueError("hook failed")

        mod = _make_hook_workflow(hooks={"before_phase": bad_hook})
        register(mod)
        try:
            _create_test_task()
            task = get_task("hook_test_1")
            # 不应抛异常
            _invoke_hook(task, "before_phase", "step1")
        finally:
            _registry.pop("test_hooks_wf", None)


class TestExecutePhaseWithHooks:
    """execute_phase 中钩子调用时机"""

    def test_all_hooks_called_on_success(self):
        before = mock.Mock()
        after = mock.Mock()

        def success_func(task_id):
            from core.state_machine import transition

            transition(task_id, "step1_done", note="done")

        mod = _make_hook_workflow(
            hooks={"before_phase": before, "after_phase": after},
            phase_func=success_func,
        )
        register(mod)
        try:
            _create_test_task(task_id="hook_success")
            with (
                mock.patch("core.runner.acquire_lock", return_value=mock.Mock()),
                mock.patch("core.runner.release_lock"),
                mock.patch("core.runner.add_task_log_handler"),
                mock.patch("core.runner.remove_task_log_handler"),
                mock.patch("core.runner.get_task_dir", return_value="/tmp"),
            ):
                execute_phase("hook_success", "step1")

            before.assert_called_once_with("hook_success", "step1")
            after.assert_called_once_with("hook_success", "step1")
        finally:
            _registry.pop("test_hooks_wf", None)

    def test_on_error_hook_called_on_failure(self):
        on_error = mock.Mock()

        def failing_func(task_id):
            raise RuntimeError("phase failed")

        mod = _make_hook_workflow(
            hooks={"on_phase_error": on_error},
            phase_func=failing_func,
        )
        register(mod)
        try:
            _create_test_task(task_id="hook_fail")
            with (
                mock.patch("core.runner.acquire_lock", return_value=mock.Mock()),
                mock.patch("core.runner.release_lock"),
                mock.patch("core.runner.add_task_log_handler"),
                mock.patch("core.runner.remove_task_log_handler"),
                mock.patch("core.runner.get_task_dir", return_value="/tmp"),
                mock.patch("core.runner.notify"),
            ):
                execute_phase("hook_fail", "step1")

            on_error.assert_called_once()
            args = on_error.call_args[0]
            assert args[0] == "hook_fail"
            assert args[1] == "step1"
            assert isinstance(args[2], RuntimeError)
        finally:
            _registry.pop("test_hooks_wf", None)

    def test_on_error_hook_on_invalid_transition(self):
        """InvalidTransitionError 也触发 on_phase_error"""
        on_error = mock.Mock()

        mod = _make_hook_workflow(hooks={"on_phase_error": on_error})
        register(mod)
        try:
            _create_test_task(task_id="hook_inv", status="pending_step1")
            # mock transition 抛出 InvalidTransitionError
            from core.state_machine import InvalidTransitionError

            with (
                mock.patch("core.runner.acquire_lock", return_value=mock.Mock()),
                mock.patch("core.runner.release_lock"),
                mock.patch("core.runner.add_task_log_handler"),
                mock.patch("core.runner.remove_task_log_handler"),
                mock.patch("core.runner.get_task_dir", return_value="/tmp"),
                mock.patch("core.runner.transition", side_effect=InvalidTransitionError("mocked")),
            ):
                execute_phase("hook_inv", "step1")

            on_error.assert_called_once()
            args = on_error.call_args[0]
            assert args[0] == "hook_inv"
            assert args[1] == "step1"
            assert isinstance(args[2], InvalidTransitionError)
        finally:
            _registry.pop("test_hooks_wf", None)


class TestHooksValidation:
    """validate_workflow 中 hooks 字段校验"""

    def test_valid_hooks(self):
        wf = {
            "name": "test_val",
            "phases": [{"name": "s", "pending_state": "p", "running_state": "r", "func": _dummy_func}],
            "initial_state": "p",
            "terminal_states": ["done"],
            "hooks": {
                "before_phase": _dummy_func,
                "after_phase": _dummy_func,
                "on_phase_error": lambda tid, ph, err: None,
            },
        }
        warns = validate_workflow(wf)
        assert not any("hooks" in w for w in warns)

    def test_unknown_hook_name(self):
        wf = {
            "name": "test_val",
            "phases": [{"name": "s", "pending_state": "p", "running_state": "r", "func": _dummy_func}],
            "initial_state": "p",
            "terminal_states": ["done"],
            "hooks": {"unknown_hook": _dummy_func},
        }
        warns = validate_workflow(wf)
        assert any("unknown_hook" in w for w in warns)

    def test_non_callable_hook(self):
        wf = {
            "name": "test_val",
            "phases": [{"name": "s", "pending_state": "p", "running_state": "r", "func": _dummy_func}],
            "initial_state": "p",
            "terminal_states": ["done"],
            "hooks": {"before_phase": "not_callable"},
        }
        warns = validate_workflow(wf)
        assert any("callable" in w for w in warns)
