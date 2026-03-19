"""
并行阶段完整生命周期测试
"""

from __future__ import annotations

from types import SimpleNamespace

from core.db import (
    all_sub_tasks_done,
    any_sub_task_failed,
    create_sub_task,
    create_task,
    get_sub_tasks,
    get_task,
)
from core.registry import (
    _registry,
    build_transitions,
    get_all_states,
    get_next_phase,
    get_parallel_def,
    get_pending_state_phase,
    get_phase,
    get_running_state_phase,
    register,
    validate_workflow,
)


def _noop(task_id: str) -> None:
    pass


def _make_parallel_workflow():
    """创建带并行阶段的测试工作流"""
    return SimpleNamespace(
        WORKFLOW={
            "name": "parallel_test",
            "description": "并行测试工作流",
            "phases": [
                {
                    "name": "design",
                    "label": "DESIGN",
                    "trigger": "start_design",
                    "pending_state": "pending_design",
                    "running_state": "running_design",
                    "complete_trigger": "design_complete",
                    "fail_trigger": "design_fail",
                    "func": _noop,
                },
                {
                    "parallel": {
                        "name": "development",
                        "fail_strategy": "cancel_all",
                        "phases": [
                            {
                                "name": "frontend",
                                "label": "FRONTEND",
                                "trigger": "start_frontend",
                                "pending_state": "pending_frontend",
                                "running_state": "running_frontend",
                                "complete_trigger": "frontend_complete",
                                "fail_trigger": "frontend_fail",
                                "func": _noop,
                            },
                            {
                                "name": "backend",
                                "label": "BACKEND",
                                "trigger": "start_backend",
                                "pending_state": "pending_backend",
                                "running_state": "running_backend",
                                "complete_trigger": "backend_complete",
                                "fail_trigger": "backend_fail",
                                "func": _noop,
                            },
                        ],
                    }
                },
                {
                    "name": "code_review",
                    "label": "CODE_REVIEW",
                    "trigger": "start_code_review",
                    "pending_state": "pending_code_review",
                    "running_state": "running_code_review",
                    "complete_trigger": "code_review_complete",
                    "fail_trigger": "code_review_fail",
                    "func": _noop,
                },
            ],
            "initial_state": "pending_design",
            "terminal_states": ["done", "cancelled"],
        }
    )


class TestParallelWorkflowRegistration:
    """并行工作流注册与校验"""

    def test_register_parallel_workflow(self):
        old = dict(_registry)
        try:
            wf_mod = _make_parallel_workflow()
            register(wf_mod)
            assert "parallel_test" in _registry
        finally:
            _registry.clear()
            _registry.update(old)

    def test_validate_parallel_workflow(self):
        wf = _make_parallel_workflow().WORKFLOW
        warnings = validate_workflow(wf)
        assert isinstance(warnings, list)


class TestParallelPhaseQuery:
    """并行阶段查询"""

    def test_get_parallel_def(self):
        old = dict(_registry)
        try:
            register(_make_parallel_workflow())

            par = get_parallel_def("parallel_test", "development")
            assert par is not None
            assert par["name"] == "development"
            assert par["fail_strategy"] == "cancel_all"
            assert len(par["phases"]) == 2
        finally:
            _registry.clear()
            _registry.update(old)

    def test_get_phase_inside_parallel(self):
        old = dict(_registry)
        try:
            register(_make_parallel_workflow())

            frontend = get_phase("parallel_test", "frontend")
            assert frontend is not None
            assert frontend["name"] == "frontend"

            backend = get_phase("parallel_test", "backend")
            assert backend is not None
        finally:
            _registry.clear()
            _registry.update(old)

    def test_get_next_phase_after_parallel(self):
        old = dict(_registry)
        try:
            register(_make_parallel_workflow())

            # design → development（并行组）
            assert get_next_phase("parallel_test", "design") == "development"
            # development（并行组） → code_review
            assert get_next_phase("parallel_test", "development") == "code_review"
            # code_review → None（最后）
            assert get_next_phase("parallel_test", "code_review") is None
        finally:
            _registry.clear()
            _registry.update(old)

    def test_running_state_phase_includes_parallel_subs(self):
        old = dict(_registry)
        try:
            register(_make_parallel_workflow())

            mapping = get_running_state_phase("parallel_test")
            assert "running_frontend" in mapping
            assert mapping["running_frontend"] == "frontend"
            assert "running_backend" in mapping
        finally:
            _registry.clear()
            _registry.update(old)

    def test_pending_state_phase_includes_parallel(self):
        old = dict(_registry)
        try:
            register(_make_parallel_workflow())

            mapping = get_pending_state_phase("parallel_test")
            assert "pending_development" in mapping
            assert "pending_frontend" in mapping
            assert "pending_backend" in mapping
        finally:
            _registry.clear()
            _registry.update(old)

    def test_all_states_includes_parallel(self):
        old = dict(_registry)
        try:
            register(_make_parallel_workflow())

            states = get_all_states("parallel_test")
            assert "pending_development" in states
            assert "waiting_development" in states
            assert "pending_frontend" in states
            assert "running_frontend" in states
        finally:
            _registry.clear()
            _registry.update(old)


class TestParallelTransitions:
    """并行阶段转换表"""

    def test_parallel_transitions_generated(self):
        old = dict(_registry)
        try:
            register(_make_parallel_workflow())
            transitions = build_transitions("parallel_test")

            # design → parallel group
            assert ("design_complete", "pending_development") in transitions["running_design"]

            # fork: pending_development → waiting_development
            assert ("start_development", "waiting_development") in transitions["pending_development"]

            # sub-phase transitions
            assert ("start_frontend", "running_frontend") in transitions["pending_frontend"]
            assert ("start_backend", "running_backend") in transitions["pending_backend"]

            # sub-phase complete
            assert ("frontend_complete", "frontend_done") in transitions["running_frontend"]
            assert ("backend_complete", "backend_done") in transitions["running_backend"]

            # join: waiting_development → pending_code_review
            assert ("development_complete", "pending_code_review") in transitions["waiting_development"]

            # fail: waiting → pending (retry)
            assert ("development_fail", "pending_development") in transitions["waiting_development"]
        finally:
            _registry.clear()
            _registry.update(old)


class TestSubTaskCRUD:
    """子任务 CRUD 操作"""

    def _create_parent(self, task_id="PAR-001"):
        create_task(
            task_id=task_id,
            req_id="REQ-PAR",
            title="并行测试",
            project="test",
            repo_path="/tmp/test",
            branch="feat/test",
            agents={},
            notify_target="",
            channel="log",
            workflow="dev",
        )
        return task_id

    def test_create_sub_task(self):
        parent_id = self._create_parent()
        create_sub_task(
            parent_task_id=parent_id,
            sub_task_id=f"{parent_id}__frontend",
            phase_name="frontend",
            parallel_group="development",
            parallel_index=0,
            initial_status="pending_frontend",
        )

        sub = get_task(f"{parent_id}__frontend")
        assert sub is not None
        assert sub["parent_task_id"] == parent_id
        assert sub["parallel_group"] == "development"
        assert sub["parallel_index"] == 0
        assert sub["status"] == "pending_frontend"

    def test_get_sub_tasks(self):
        parent_id = self._create_parent("PAR-002")
        create_sub_task(parent_id, f"{parent_id}__fe", "frontend", "dev", 0)
        create_sub_task(parent_id, f"{parent_id}__be", "backend", "dev", 1)

        subs = get_sub_tasks(parent_id)
        assert len(subs) == 2
        assert subs[0]["parallel_index"] == 0
        assert subs[1]["parallel_index"] == 1

    def test_all_sub_tasks_done(self):
        parent_id = self._create_parent("PAR-003")
        create_sub_task(parent_id, f"{parent_id}__a", "a", "grp", 0, initial_status="pending_a")
        create_sub_task(parent_id, f"{parent_id}__b", "b", "grp", 1, initial_status="pending_b")

        assert not all_sub_tasks_done(parent_id)

        # 把子任务标记为完成
        from core.db import get_conn, now

        with get_conn() as conn:
            conn.execute(
                "UPDATE tasks SET status = 'a_done', updated_at = ? WHERE id = ?",
                (now(), f"{parent_id}__a"),
            )
            conn.execute(
                "UPDATE tasks SET status = 'b_done', updated_at = ? WHERE id = ?",
                (now(), f"{parent_id}__b"),
            )

        assert all_sub_tasks_done(parent_id)

    def test_any_sub_task_failed(self):
        parent_id = self._create_parent("PAR-004")
        create_sub_task(parent_id, f"{parent_id}__a", "a", "grp", 0, initial_status="running_a")
        create_sub_task(parent_id, f"{parent_id}__b", "b", "grp", 1, initial_status="running_b")

        assert not any_sub_task_failed(parent_id)

        from core.db import get_conn, now

        with get_conn() as conn:
            conn.execute(
                "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?",
                (now(), f"{parent_id}__a"),
            )

        assert any_sub_task_failed(parent_id)

    def test_no_sub_tasks_all_done(self):
        parent_id = self._create_parent("PAR-005")
        assert all_sub_tasks_done(parent_id)

    def test_sub_task_inherits_parent_info(self):
        parent_id = self._create_parent("PAR-006")
        create_sub_task(parent_id, f"{parent_id}__fe", "frontend", "dev", 0)

        sub = get_task(f"{parent_id}__fe")
        parent = get_task(parent_id)

        assert sub["project"] == parent["project"]
        assert sub["repo_path"] == parent["repo_path"]
        assert sub["branch"] == parent["branch"]
        assert sub["workflow"] == parent["workflow"]


class TestActiveTasksFiltering:
    """活跃任务过滤"""

    def test_exclude_sub_tasks(self):
        from core.db import get_active_tasks

        parent_id = "ACTIVE-001"
        create_task(
            task_id=parent_id,
            req_id="REQ-ACT",
            title="活跃任务测试",
            project="test",
            repo_path="/tmp/test",
            branch="feat/test",
            agents={},
            notify_target="",
            channel="log",
            workflow="dev",
        )
        create_sub_task(parent_id, f"{parent_id}__sub", "step", "grp", 0)

        all_tasks = get_active_tasks(include_sub_tasks=True)
        top_only = get_active_tasks(include_sub_tasks=False)

        assert len(all_tasks) >= 2
        assert len(top_only) >= 1
        assert all(t.get("parent_task_id") is None for t in top_only)
