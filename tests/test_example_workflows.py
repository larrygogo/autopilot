"""
示例工作流端到端测试：从 examples/ 目录磁盘加载 YAML，完成加载→校验→注册→转换表→状态流转全链路
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core.db import create_task, get_task
from core.registry import (
    _registry,
    build_transitions,
    load_yaml_workflow,
    register,
    validate_workflow,
)
from core.state_machine import transition

EXAMPLES_DIR = Path(__file__).parent.parent / "examples"


# ──────────────────────────────────────────────────────────
# 辅助函数
# ──────────────────────────────────────────────────────────


def _get_example_dirs():
    """获取所有包含 workflow.yaml 的示例目录"""
    dirs = []
    for d in sorted(EXAMPLES_DIR.iterdir()):
        if d.is_dir() and (d / "workflow.yaml").exists():
            dirs.append(d)
    return dirs


def _register_task(task_id, workflow):
    """注册一个测试任务"""
    create_task(
        task_id=task_id,
        req_id=f"REQ-{task_id}",
        title=f"测试任务 {task_id}",
        project="test-project",
        repo_path="/tmp/test-repo",
        branch=f"feat/{task_id}",
        agents={},
        notify_target="",
        channel="log",
        workflow=workflow,
    )


# ──────────────────────────────────────────────────────────
# 参数化示例目录列表
# ──────────────────────────────────────────────────────────

EXAMPLE_DIRS = _get_example_dirs()
EXAMPLE_IDS = [d.name for d in EXAMPLE_DIRS]


# ──────────────────────────────────────────────────────────
# 加载与校验测试
# ──────────────────────────────────────────────────────────


class TestExampleWorkflowsLoadAndValidate:
    """参数化测试：遍历所有 examples/*/workflow.yaml"""

    @pytest.mark.parametrize("example_dir", EXAMPLE_DIRS, ids=EXAMPLE_IDS)
    def test_load_from_disk(self, example_dir):
        """load_yaml_workflow 成功"""
        mod = load_yaml_workflow(example_dir)
        assert mod is not None, f"{example_dir.name} 加载失败"
        assert hasattr(mod, "WORKFLOW")
        assert isinstance(mod.WORKFLOW, dict)

    @pytest.mark.parametrize("example_dir", EXAMPLE_DIRS, ids=EXAMPLE_IDS)
    def test_validate_passes(self, example_dir):
        """validate_workflow 通过"""
        mod = load_yaml_workflow(example_dir)
        warns = validate_workflow(mod.WORKFLOW)
        assert isinstance(warns, list)

    @pytest.mark.parametrize("example_dir", EXAMPLE_DIRS, ids=EXAMPLE_IDS)
    def test_prelaunch_passes(self, example_dir):
        """注册后校验通过：注册 → build_transitions → 非空"""
        mod = load_yaml_workflow(example_dir)
        old_registry = dict(_registry)
        try:
            register(mod)
            wf_name = mod.WORKFLOW["name"]
            transitions = build_transitions(wf_name)
            assert isinstance(transitions, dict)
            assert len(transitions) > 0
            initial = mod.WORKFLOW["initial_state"]
            assert initial in transitions, f"initial_state '{initial}' 不在转换表中"
        finally:
            _registry.clear()
            _registry.update(old_registry)

    @pytest.mark.parametrize("example_dir", EXAMPLE_DIRS, ids=EXAMPLE_IDS)
    def test_build_transitions_nonempty(self, example_dir):
        """转换表非空"""
        mod = load_yaml_workflow(example_dir)
        old_registry = dict(_registry)
        try:
            register(mod)
            wf_name = mod.WORKFLOW["name"]
            transitions = build_transitions(wf_name)
            assert len(transitions) > 0
        finally:
            _registry.clear()
            _registry.update(old_registry)


# ──────────────────────────────────────────────────────────
# doc_gen 状态机测试
# ──────────────────────────────────────────────────────────


class TestDocGenStateMachine:
    """doc_gen 工作流状态流转测试（自动推导转换表）"""

    @pytest.fixture(autouse=True)
    def _setup_doc_gen(self):
        doc_gen_dir = EXAMPLES_DIR / "doc_gen"
        mod = load_yaml_workflow(doc_gen_dir)
        assert mod is not None
        old_registry = dict(_registry)
        register(mod)
        yield
        _registry.clear()
        _registry.update(old_registry)

    def test_happy_path(self):
        """自动推导 → pending_generate → running_generate → ... → done"""
        _register_task("DG-001", "doc_gen")
        task = get_task("DG-001")
        assert task["status"] == "pending_generate"

        flow = [
            ("start_generate", "running_generate"),
            ("generate_complete", "pending_review_doc"),
            ("start_review_doc", "running_review_doc"),
            ("review_doc_complete", "done"),
        ]
        for trigger, expected in flow:
            _, to = transition("DG-001", trigger)
            assert to == expected

    def test_reject_cycle(self):
        """review_doc reject → retry generate → 再通过"""
        _register_task("DG-002", "doc_gen")

        for t in ["start_generate", "generate_complete", "start_review_doc"]:
            transition("DG-002", t)

        _, to = transition("DG-002", "review_doc_reject")
        assert to == "review_doc_rejected"

        _, to = transition("DG-002", "retry_generate")
        assert to == "pending_generate"

        for t in ["start_generate", "generate_complete", "start_review_doc"]:
            transition("DG-002", t)

        _, to = transition("DG-002", "review_doc_complete")
        assert to == "done"


# ──────────────────────────────────────────────────────────
# parallel_build 转换表测试
# ──────────────────────────────────────────────────────────


class TestParallelBuildTransitions:
    """parallel_build 工作流转换表测试"""

    @pytest.fixture(autouse=True)
    def _setup_parallel_build(self):
        pb_dir = EXAMPLES_DIR / "parallel_build"
        mod = load_yaml_workflow(pb_dir)
        assert mod is not None
        old_registry = dict(_registry)
        register(mod)
        yield
        _registry.clear()
        _registry.update(old_registry)

    def test_transitions_nonempty(self):
        """转换表非空"""
        transitions = build_transitions("parallel_build")
        assert len(transitions) > 0

    def test_prepare_transitions(self):
        """prepare 阶段转换正确"""
        transitions = build_transitions("parallel_build")
        assert "pending_prepare" in transitions
        triggers = {t: d for t, d in transitions["pending_prepare"]}
        assert "start_prepare" in triggers

    def test_parallel_block_in_transitions(self):
        """并行块相关状态存在于转换表"""
        transitions = build_transitions("parallel_build")
        # 并行块应产生 pending_build / waiting_build 等状态
        all_states = set(transitions.keys())
        for pairs in transitions.values():
            for _, dest in pairs:
                all_states.add(dest)
        # 子阶段应存在
        assert any("build_frontend" in s for s in all_states)
        assert any("build_backend" in s for s in all_states)

    def test_hooks_defined(self):
        """hooks 已正确定义"""
        from core.registry import get_workflow

        wf = get_workflow("parallel_build")
        assert "hooks" in wf
        assert "before_phase" in wf["hooks"]
        assert "after_phase" in wf["hooks"]
        assert callable(wf["hooks"]["before_phase"])
        assert callable(wf["hooks"]["after_phase"])


# ──────────────────────────────────────────────────────────
# data_pipeline 状态机测试
# ──────────────────────────────────────────────────────────


class TestDataPipelineStateMachine:
    """data_pipeline 工作流状态流转测试"""

    @pytest.fixture(autouse=True)
    def _setup_data_pipeline(self):
        dp_dir = EXAMPLES_DIR / "data_pipeline"
        mod = load_yaml_workflow(dp_dir)
        assert mod is not None
        old_registry = dict(_registry)
        register(mod)
        yield
        _registry.clear()
        _registry.update(old_registry)

    def test_happy_path(self):
        """extract → validate → transform → load → completed"""
        _register_task("DP-001", "data_pipeline")
        task = get_task("DP-001")
        assert task["status"] == "pending_extract"

        flow = [
            ("start_extract", "running_extract"),
            ("extract_complete", "pending_validate_data"),
            ("start_validate_data", "running_validate_data"),
            ("validate_data_complete", "pending_transform"),
            ("start_transform", "running_transform"),
            ("transform_complete", "pending_load"),
            ("start_load", "running_load"),
            ("load_complete", "completed"),
        ]
        for trigger, expected in flow:
            _, to = transition("DP-001", trigger)
            assert to == expected

    def test_forward_jump(self):
        """validate_skip 跳转到 load"""
        _register_task("DP-002", "data_pipeline")

        for t in ["start_extract", "extract_complete", "start_validate_data"]:
            transition("DP-002", t)

        _, to = transition("DP-002", "validate_skip")
        assert to == "pending_load"

        transition("DP-002", "start_load")
        _, to = transition("DP-002", "load_complete")
        assert to == "completed"

    def test_reject_back_to_extract(self):
        """transform reject → extract"""
        _register_task("DP-003", "data_pipeline")

        for t in [
            "start_extract",
            "extract_complete",
            "start_validate_data",
            "validate_data_complete",
            "start_transform",
        ]:
            transition("DP-003", t)

        _, to = transition("DP-003", "transform_reject")
        assert to == "transform_rejected"

        _, to = transition("DP-003", "retry_extract")
        assert to == "pending_extract"

    def test_multiple_terminal_states(self):
        """多终态：completed_partial"""
        _register_task("DP-004", "data_pipeline")

        for t in [
            "start_extract",
            "extract_complete",
            "start_validate_data",
            "validate_data_complete",
            "start_transform",
            "transform_complete",
            "start_load",
        ]:
            transition("DP-004", t)

        _, to = transition("DP-004", "load_partial")
        assert to == "completed_partial"

    def test_retry_policy_defined(self):
        """retry_policy 已正确定义"""
        from core.registry import get_workflow

        wf = get_workflow("data_pipeline")
        assert "retry_policy" in wf
        assert wf["retry_policy"]["max_retries"] == 5
        assert wf["retry_policy"]["backoff"] == "exponential"
        assert wf["retry_policy"]["delay"] == 30
