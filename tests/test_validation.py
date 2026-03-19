"""
工作流校验单元测试
"""

import pytest

from core.registry import WorkflowValidationError, validate_workflow


def _dummy_func(task_id: str) -> None:
    pass


def _make_workflow(**overrides) -> dict:
    """构建最小合法 WORKFLOW 字典"""
    base = {
        "name": "test_wf",
        "phases": [
            {
                "name": "step1",
                "pending_state": "pending_step1",
                "running_state": "running_step1",
                "trigger": "start_step1",
                "func": _dummy_func,
            },
        ],
        "initial_state": "pending_step1",
        "terminal_states": ["done", "cancelled"],
    }
    base.update(overrides)
    return base


class TestValidWorkflow:
    """合法 WORKFLOW 通过校验"""

    def test_minimal_workflow(self):
        warns = validate_workflow(_make_workflow())
        assert isinstance(warns, list)

    def test_no_warnings_for_minimal(self):
        warns = validate_workflow(_make_workflow())
        assert warns == []

    def test_existing_dev_workflow(self):
        from core.registry import get_workflow

        wf = get_workflow("dev")
        warns = validate_workflow(wf)
        assert isinstance(warns, list)

    def test_existing_req_review_workflow(self):
        from core.registry import get_workflow

        wf = get_workflow("req_review")
        warns = validate_workflow(wf)
        assert isinstance(warns, list)


class TestMissingFields:
    """缺必须字段 raise"""

    def test_missing_name(self):
        wf = _make_workflow()
        del wf["name"]
        with pytest.raises(WorkflowValidationError, match="name"):
            validate_workflow(wf)

    def test_missing_phases(self):
        wf = _make_workflow()
        del wf["phases"]
        with pytest.raises(WorkflowValidationError, match="phases"):
            validate_workflow(wf)

    def test_missing_initial_state(self):
        wf = _make_workflow()
        del wf["initial_state"]
        with pytest.raises(WorkflowValidationError, match="initial_state"):
            validate_workflow(wf)

    def test_missing_terminal_states(self):
        wf = _make_workflow()
        del wf["terminal_states"]
        with pytest.raises(WorkflowValidationError, match="terminal_states"):
            validate_workflow(wf)

    def test_empty_phases(self):
        with pytest.raises(WorkflowValidationError, match="不能为空"):
            validate_workflow(_make_workflow(phases=[]))

    def test_empty_terminal_states(self):
        with pytest.raises(WorkflowValidationError, match="不能为空"):
            validate_workflow(_make_workflow(terminal_states=[]))

    def test_wrong_type_name(self):
        with pytest.raises(WorkflowValidationError, match="类型错误"):
            validate_workflow(_make_workflow(name=123))


class TestPhaseValidation:
    """阶段级校验"""

    def test_missing_phase_name(self):
        wf = _make_workflow()
        del wf["phases"][0]["name"]
        with pytest.raises(WorkflowValidationError, match="name"):
            validate_workflow(wf)

    def test_missing_phase_func(self):
        wf = _make_workflow()
        del wf["phases"][0]["func"]
        with pytest.raises(WorkflowValidationError, match="func"):
            validate_workflow(wf)

    def test_non_callable_func(self):
        wf = _make_workflow()
        wf["phases"][0]["func"] = "not_callable"
        with pytest.raises(WorkflowValidationError, match="callable"):
            validate_workflow(wf)

    def test_duplicate_phase_name(self):
        wf = _make_workflow()
        wf["phases"].append(
            {
                "name": "step1",  # 重复
                "pending_state": "pending_step1b",
                "running_state": "running_step1b",
                "func": _dummy_func,
            }
        )
        with pytest.raises(WorkflowValidationError, match="重复"):
            validate_workflow(wf)

    def test_jump_trigger_without_jump_target(self):
        wf = _make_workflow()
        wf["phases"][0]["jump_trigger"] = "reject_step1"
        warns = validate_workflow(wf)
        assert any("jump_target" in w for w in warns)

    def test_jump_target_not_in_phases(self):
        wf = _make_workflow()
        wf["phases"][0]["jump_trigger"] = "reject_step1"
        wf["phases"][0]["jump_target"] = "nonexistent"
        with pytest.raises(WorkflowValidationError, match="nonexistent"):
            validate_workflow(wf)


class TestTransitionCompleteness:
    """转换表完整性"""

    def test_initial_state_in_transitions(self):
        wf = _make_workflow()
        wf["transitions"] = {"other_state": [("go", "done")]}
        warns = validate_workflow(wf)
        assert any("initial_state" in w for w in warns)

    def test_initial_state_matches_first_phase(self):
        wf = _make_workflow(initial_state="wrong_state")
        warns = validate_workflow(wf)
        assert any("initial_state" in w for w in warns)

    def test_trigger_none_and_same_state_ok(self):
        """兼容 trigger=None 和 pending==running 的阶段"""
        wf = _make_workflow()
        wf["phases"][0]["trigger"] = None
        wf["phases"][0]["pending_state"] = "same"
        wf["phases"][0]["running_state"] = "same"
        wf["initial_state"] = "same"
        warns = validate_workflow(wf)
        assert isinstance(warns, list)


class TestOptionalFieldTypes:
    """可选字段类型警告"""

    def test_hooks_not_dict(self):
        wf = _make_workflow(hooks="bad")
        warns = validate_workflow(wf)
        assert any("hooks" in w for w in warns)

    def test_retry_policy_not_dict(self):
        wf = _make_workflow(retry_policy="bad")
        warns = validate_workflow(wf)
        assert any("retry_policy" in w for w in warns)
