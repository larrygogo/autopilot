"""
数据处理流水线工作流：前向跳转 + 多终态 + 重试策略示例
Data pipeline workflow: forward jump + multiple terminal states + retry policy example

展示特性：jump_trigger/jump_target 前向跳转、多终态、retry_policy、reject 与 jump 混用
Features: forward jump, multiple terminal states, retry_policy, mixed reject & jump
"""

from __future__ import annotations

from core.logger import get_logger

log = get_logger()


def run_extract(task_id: str) -> None:
    """数据抽取（占位）
    Data extraction (placeholder)."""
    log.info("[data_pipeline] extract 阶段执行：task=%s", task_id)


def run_validate_data(task_id: str) -> None:
    """数据校验（占位）
    Data validation (placeholder)."""
    log.info("[data_pipeline] validate_data 阶段执行：task=%s", task_id)


def run_transform(task_id: str) -> None:
    """数据转换（占位）
    Data transformation (placeholder)."""
    log.info("[data_pipeline] transform 阶段执行：task=%s", task_id)


def run_load(task_id: str) -> None:
    """数据加载（占位）
    Data loading (placeholder)."""
    log.info("[data_pipeline] load 阶段执行：task=%s", task_id)
