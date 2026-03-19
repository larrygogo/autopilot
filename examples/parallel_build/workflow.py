"""
并行构建流程工作流：并行阶段 + hooks 示例
展示特性：parallel fork/join、hooks（before_phase/after_phase）、手写 transitions、fail_strategy
"""

from __future__ import annotations

from core.logger import get_logger

log = get_logger()


# ──────────────────────────────────────────────────────────
# Hook 函数
# ──────────────────────────────────────────────────────────


def on_before_phase(task: dict, phase_name: str) -> None:
    """阶段开始前钩子"""
    log.info("[parallel_build] before_phase: task=%s phase=%s", task.get("id"), phase_name)


def on_after_phase(task: dict, phase_name: str) -> None:
    """阶段完成后钩子"""
    log.info("[parallel_build] after_phase: task=%s phase=%s", task.get("id"), phase_name)


# ──────────────────────────────────────────────────────────
# 阶段函数
# ──────────────────────────────────────────────────────────


def run_prepare(task_id: str) -> None:
    """准备阶段（占位）"""
    log.info("[parallel_build] prepare 阶段执行：task=%s", task_id)


def run_build_frontend(task_id: str) -> None:
    """前端构建（占位）"""
    log.info("[parallel_build] build_frontend 阶段执行：task=%s", task_id)


def run_build_backend(task_id: str) -> None:
    """后端构建（占位）"""
    log.info("[parallel_build] build_backend 阶段执行：task=%s", task_id)


def run_integration_test(task_id: str) -> None:
    """集成测试（占位）"""
    log.info("[parallel_build] integration_test 阶段执行：task=%s", task_id)


# ──────────────────────────────────────────────────────────
# 工作流定义 — 手写 transitions 表达并行 fork/join
# ──────────────────────────────────────────────────────────

WORKFLOW = {
    "name": "parallel_build",
    "description": "并行构建流程",
    "hooks": {
        "before_phase": on_before_phase,
        "after_phase": on_after_phase,
    },
    "phases": [
        {
            "name": "prepare",
            "pending_state": "pending_prepare",
            "running_state": "running_prepare",
            "trigger": "start_prepare",
            "complete_trigger": "prepare_complete",
            "fail_trigger": "prepare_fail",
            "timeout_key": "prepare",
            "func": run_prepare,
        },
        {
            "name": "build_frontend",
            "pending_state": "pending_build_frontend",
            "running_state": "running_build_frontend",
            "trigger": "start_build_frontend",
            "complete_trigger": "build_frontend_complete",
            "fail_trigger": "build_frontend_fail",
            "timeout_key": "build",
            "func": run_build_frontend,
        },
        {
            "name": "build_backend",
            "pending_state": "pending_build_backend",
            "running_state": "running_build_backend",
            "trigger": "start_build_backend",
            "complete_trigger": "build_backend_complete",
            "fail_trigger": "build_backend_fail",
            "timeout_key": "build",
            "func": run_build_backend,
        },
        {
            "name": "integration_test",
            "pending_state": "pending_integration_test",
            "running_state": "running_integration_test",
            "trigger": "start_integration_test",
            "complete_trigger": "integration_test_complete",
            "fail_trigger": "integration_test_fail",
            "timeout_key": "integration_test",
            "func": run_integration_test,
        },
    ],
    "initial_state": "pending_prepare",
    "terminal_states": ["build_done", "cancelled"],
    # 手写转换表：并行 fork/join 模式
    "transitions": {
        # 准备阶段
        "pending_prepare": [("start_prepare", "running_prepare"), ("cancel", "cancelled")],
        "running_prepare": [("prepare_complete", "pending_build"), ("prepare_fail", "pending_prepare"), ("cancel", "cancelled")],
        # 并行 fork：pending_build → waiting_build（同时启动 frontend + backend）
        "pending_build": [("start_build", "waiting_build"), ("cancel", "cancelled")],
        "waiting_build": [("build_complete", "pending_integration_test"), ("cancel", "cancelled")],
        # 子阶段：build_frontend
        "pending_build_frontend": [("start_build_frontend", "running_build_frontend"), ("cancel", "cancelled")],
        "running_build_frontend": [("build_frontend_complete", "build_frontend_done"), ("build_frontend_fail", "pending_build_frontend"), ("cancel", "cancelled")],
        # 子阶段：build_backend
        "pending_build_backend": [("start_build_backend", "running_build_backend"), ("cancel", "cancelled")],
        "running_build_backend": [("build_backend_complete", "build_backend_done"), ("build_backend_fail", "pending_build_backend"), ("cancel", "cancelled")],
        # 集成测试
        "pending_integration_test": [("start_integration_test", "running_integration_test"), ("cancel", "cancelled")],
        "running_integration_test": [("integration_test_complete", "build_done"), ("integration_test_fail", "pending_integration_test"), ("cancel", "cancelled")],
    },
}
