"""
YAML 工作流加载 + 自动推导测试
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from core.registry import (
    WorkflowValidationError,
    _expand_phase_defaults,
    _normalize_transitions,
    build_transitions,
    get_phase,
    get_phase_func,
    load_yaml_workflow,
    validate_workflow,
)


class TestExpandPhaseDefaults:
    """状态自动推导"""

    def test_basic_expansion(self):
        phase = {"name": "design", "timeout": 900}
        expanded = _expand_phase_defaults(phase, {"design", "review"})

        assert expanded["pending_state"] == "pending_design"
        assert expanded["running_state"] == "running_design"
        assert expanded["trigger"] == "start_design"
        assert expanded["complete_trigger"] == "design_complete"
        assert expanded["fail_trigger"] == "design_fail"
        assert expanded["label"] == "DESIGN"

    def test_explicit_values_not_overridden(self):
        phase = {
            "name": "dev",
            "pending_state": "developing",
            "running_state": "in_development",
            "trigger": "start_dev",
            "label": "DEVELOPMENT",
        }
        expanded = _expand_phase_defaults(phase, {"dev"})

        assert expanded["pending_state"] == "developing"
        assert expanded["running_state"] == "in_development"
        assert expanded["trigger"] == "start_dev"
        assert expanded["label"] == "DEVELOPMENT"

    def test_reject_sugar(self):
        phase = {"name": "review", "timeout": 900, "reject": "design"}
        expanded = _expand_phase_defaults(phase, {"design", "review"})

        assert expanded["jump_trigger"] == "review_reject"
        assert expanded["jump_target"] == "design"
        assert expanded["_jump_origin"] == "reject"
        assert expanded["max_rejections"] == 10
        assert "reject" not in expanded  # 语法糖已消费

    def test_reject_with_custom_max(self):
        phase = {"name": "review", "reject": "design", "max_rejections": 5}
        expanded = _expand_phase_defaults(phase, {"design", "review"})

        assert expanded["max_rejections"] == 5  # 不被默认 10 覆盖

    def test_legacy_reject_trigger_mapped(self):
        """旧字段 reject_trigger/retry_target 自动映射为 jump_trigger/jump_target"""
        phase = {
            "name": "review",
            "reject_trigger": "review_reject",
            "retry_target": "design",
        }
        expanded = _expand_phase_defaults(phase, {"design", "review"})

        assert expanded["jump_trigger"] == "review_reject"
        assert expanded["jump_target"] == "design"
        assert "reject_trigger" not in expanded
        assert "retry_target" not in expanded


class TestNormalizeTransitions:
    """YAML transitions 格式转换"""

    def test_list_to_tuple(self):
        raw = {
            "pending_design": [["start_design", "designing"], ["cancel", "cancelled"]],
            "designing": [["design_complete", "pending_review"]],
        }
        normalized = _normalize_transitions(raw)

        assert normalized["pending_design"] == [("start_design", "designing"), ("cancel", "cancelled")]
        assert normalized["designing"] == [("design_complete", "pending_review")]

    def test_tuple_passthrough(self):
        raw = {
            "state_a": [("trigger_a", "state_b")],
        }
        normalized = _normalize_transitions(raw)
        assert normalized["state_a"] == [("trigger_a", "state_b")]


class TestLoadYAMLWorkflow:
    """YAML 工作流加载"""

    def test_load_minimal_yaml(self, tmp_path):
        """最简 YAML + Python"""
        yaml_content = """
name: test_wf
description: 测试工作流
phases:
  - name: step1
    timeout: 900
  - name: step2
    timeout: 600
"""
        py_content = """
def run_step1(task_id):
    pass

def run_step2(task_id):
    pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        assert mod is not None

        wf = mod.WORKFLOW
        assert wf["name"] == "test_wf"
        assert len(wf["phases"]) == 2

        # 自动推导
        assert wf["initial_state"] == "pending_step1"
        assert wf["terminal_states"] == ["done", "cancelled"]

        p1 = wf["phases"][0]
        assert p1["pending_state"] == "pending_step1"
        assert p1["running_state"] == "running_step1"
        assert p1["trigger"] == "start_step1"
        assert callable(p1["func"])

    def test_load_with_explicit_fields(self, tmp_path):
        """显式字段不被覆盖"""
        yaml_content = """
name: explicit_wf
initial_state: custom_init
terminal_states: [completed, cancelled]
phases:
  - name: build
    pending_state: custom_pending
    running_state: custom_running
    trigger: custom_trigger
    complete_trigger: build_done
    fail_trigger: build_fail
    label: BUILD
"""
        py_content = """
def run_build(task_id):
    pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        wf = mod.WORKFLOW

        assert wf["initial_state"] == "custom_init"
        assert wf["terminal_states"] == ["completed", "cancelled"]

        p = wf["phases"][0]
        assert p["pending_state"] == "custom_pending"
        assert p["running_state"] == "custom_running"
        assert p["trigger"] == "custom_trigger"
        assert p["label"] == "BUILD"

    def test_func_binding(self, tmp_path):
        """函数绑定"""
        yaml_content = """
name: func_test
phases:
  - name: step1
    func: my_custom_func
"""
        py_content = """
def my_custom_func(task_id):
    return "custom"
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        wf = mod.WORKFLOW
        assert callable(wf["phases"][0]["func"])

    def test_setup_notify_binding(self, tmp_path):
        """setup_func 和 notify_func 绑定"""
        yaml_content = """
name: hook_test
setup_func: my_setup
notify_func: my_notify
phases:
  - name: step1
"""
        py_content = """
def my_setup(args):
    return {}

def my_notify(task, msg):
    pass

def run_step1(task_id):
    pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        wf = mod.WORKFLOW
        assert callable(wf["setup_func"])
        assert callable(wf["notify_func"])

    def test_hooks_binding(self, tmp_path):
        """hooks 函数绑定"""
        yaml_content = """
name: hooks_test
hooks:
  before_phase: on_before
  after_phase: on_after
phases:
  - name: step1
"""
        py_content = """
def on_before(task_id, phase):
    pass

def on_after(task_id, phase):
    pass

def run_step1(task_id):
    pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        wf = mod.WORKFLOW
        assert callable(wf["hooks"]["before_phase"])
        assert callable(wf["hooks"]["after_phase"])

    def test_yaml_transitions_converted(self, tmp_path):
        """YAML 中的 transitions 列表转为元组"""
        yaml_content = """
name: trans_test
initial_state: pending_step1
terminal_states: [done, cancelled]
phases:
  - name: step1
    pending_state: pending_step1
    running_state: running_step1
    trigger: start_step1
    complete_trigger: step1_complete
    fail_trigger: step1_fail
transitions:
  pending_step1:
    - [start_step1, running_step1]
    - [cancel, cancelled]
  running_step1:
    - [step1_complete, done]
"""
        py_content = """
def run_step1(task_id):
    pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        wf = mod.WORKFLOW

        assert wf["transitions"]["pending_step1"] == [("start_step1", "running_step1"), ("cancel", "cancelled")]
        assert wf["transitions"]["running_step1"] == [("step1_complete", "done")]

    def test_nonexistent_dir(self, tmp_path):
        """不存在的目录返回 None"""
        result = load_yaml_workflow(tmp_path / "nonexistent")
        assert result is None

    def test_no_yaml_file(self, tmp_path):
        """没有 workflow.yaml 返回 None"""
        result = load_yaml_workflow(tmp_path)
        assert result is None

    def test_reject_sugar_in_yaml(self, tmp_path):
        """YAML 中的 reject 语法糖"""
        yaml_content = """
name: reject_test
phases:
  - name: design
    timeout: 900
  - name: review
    timeout: 900
    reject: design
    max_rejections: 5
"""
        py_content = """
def run_design(task_id):
    pass

def run_review(task_id):
    pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        wf = mod.WORKFLOW

        review = wf["phases"][1]
        assert review["jump_trigger"] == "review_reject"
        assert review["jump_target"] == "design"
        assert review["max_rejections"] == 5


class TestYAMLWorkflowValidation:
    """YAML 工作流校验"""

    def test_valid_yaml_workflow_passes_validation(self, tmp_path):
        yaml_content = """
name: valid_wf
phases:
  - name: step1
"""
        py_content = "def run_step1(task_id): pass"

        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        warnings = validate_workflow(mod.WORKFLOW)
        # 允许警告，不应抛异常
        assert isinstance(warnings, list)


class TestAutoTransitionsFromYAML:
    """YAML 工作流的自动转换表生成"""

    def test_auto_transitions(self, tmp_path):
        yaml_content = """
name: auto_trans
phases:
  - name: step1
  - name: step2
"""
        py_content = """
def run_step1(task_id): pass
def run_step2(task_id): pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        from core.registry import _registry, register

        old = dict(_registry)
        try:
            register(mod)
            transitions = build_transitions("auto_trans")

            # step1: pending → running → step2.pending
            assert ("start_step1", "running_step1") in transitions["pending_step1"]
            assert ("step1_complete", "pending_step2") in transitions["running_step1"]

            # step2: pending → running → done
            assert ("start_step2", "running_step2") in transitions["pending_step2"]
            assert ("step2_complete", "done") in transitions["running_step2"]

            # cancel everywhere
            assert ("cancel", "cancelled") in transitions["pending_step1"]
            assert ("cancel", "cancelled") in transitions["running_step1"]
        finally:
            _registry.clear()
            _registry.update(old)


class TestRejectDirectionValidation:
    """reject 语法糖方向校验"""

    def test_reject_forward_target_raises(self, tmp_path):
        """reject 目标在当前阶段之后 → 校验失败"""
        yaml_content = """
name: bad_reject
phases:
  - name: step1
    reject: step2
  - name: step2
"""
        py_content = """
def run_step1(task_id): pass
def run_step2(task_id): pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        with pytest.raises(WorkflowValidationError, match="必须在当前阶段之前"):
            validate_workflow(mod.WORKFLOW)

    def test_reject_self_raises(self, tmp_path):
        """reject 目标是自身 → 校验失败"""
        yaml_content = """
name: self_reject
phases:
  - name: step1
    reject: step1
"""
        py_content = "def run_step1(task_id): pass"

        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        with pytest.raises(WorkflowValidationError, match="必须在当前阶段之前"):
            validate_workflow(mod.WORKFLOW)

    def test_jump_target_forward_allowed(self, tmp_path):
        """直接使用 jump_trigger/jump_target 可以向前跳（不受 reject 方向限制）"""
        yaml_content = """
name: forward_jump
phases:
  - name: step1
    jump_trigger: step1_skip
    jump_target: step3
  - name: step2
  - name: step3
"""
        py_content = """
def run_step1(task_id): pass
def run_step2(task_id): pass
def run_step3(task_id): pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        warns = validate_workflow(mod.WORKFLOW)
        assert isinstance(warns, list)  # 不抛异常

    def test_reject_backward_allowed(self, tmp_path):
        """reject 目标在当前阶段之前 → 正常通过"""
        yaml_content = """
name: good_reject
phases:
  - name: step1
  - name: step2
    reject: step1
"""
        py_content = """
def run_step1(task_id): pass
def run_step2(task_id): pass
"""
        (tmp_path / "workflow.yaml").write_text(yaml_content)
        (tmp_path / "workflow.py").write_text(py_content)

        mod = load_yaml_workflow(tmp_path)
        warns = validate_workflow(mod.WORKFLOW)
        assert isinstance(warns, list)  # 不抛异常
