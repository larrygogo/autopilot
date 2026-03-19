"""
并行构建流程工作流：并行阶段 + hooks 示例
展示特性：parallel fork/join、hooks（before_phase/after_phase）、auto-transitions、fail_strategy
"""

from __future__ import annotations

from core.logger import get_logger

log = get_logger()


# ── Hook 函数 ──


def on_before_phase(task: dict, phase_name: str) -> None:
    """阶段开始前钩子"""
    log.info("[parallel_build] before_phase: task=%s phase=%s", task.get("id"), phase_name)


def on_after_phase(task: dict, phase_name: str) -> None:
    """阶段完成后钩子"""
    log.info("[parallel_build] after_phase: task=%s phase=%s", task.get("id"), phase_name)


# ── 阶段函数 ──


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
