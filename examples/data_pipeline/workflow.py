"""
数据处理流水线工作流：前向跳转 + 多终态 + 重试策略示例
展示特性：jump_trigger/jump_target 前向跳转、多终态、retry_policy、reject 与 jump 混用
"""

from __future__ import annotations

from core.logger import get_logger

log = get_logger()


# ──────────────────────────────────────────────────────────
# 阶段函数
# ──────────────────────────────────────────────────────────


def run_extract(task_id: str) -> None:
    """数据抽取（占位）"""
    log.info("[data_pipeline] extract 阶段执行：task=%s", task_id)


def run_validate_data(task_id: str) -> None:
    """数据校验（占位）"""
    log.info("[data_pipeline] validate_data 阶段执行：task=%s", task_id)


def run_transform(task_id: str) -> None:
    """数据转换（占位）"""
    log.info("[data_pipeline] transform 阶段执行：task=%s", task_id)


def run_load(task_id: str) -> None:
    """数据加载（占位）"""
    log.info("[data_pipeline] load 阶段执行：task=%s", task_id)


# ──────────────────────────────────────────────────────────
# 工作流定义 — 手写 transitions 支持前向跳转和多终态
# ──────────────────────────────────────────────────────────

WORKFLOW = {
    "name": "data_pipeline",
    "description": "数据处理流水线",
    "retry_policy": {
        "max_retries": 5,
        "backoff": "exponential",
        "delay": 30,
    },
    "phases": [
        {
            "name": "extract",
            "pending_state": "pending_extract",
            "running_state": "running_extract",
            "trigger": "start_extract",
            "complete_trigger": "extract_complete",
            "fail_trigger": "extract_fail",
            "timeout_key": "extract",
            "func": run_extract,
        },
        {
            "name": "validate_data",
            "pending_state": "pending_validate_data",
            "running_state": "running_validate_data",
            "trigger": "start_validate_data",
            "complete_trigger": "validate_data_complete",
            "fail_trigger": "validate_data_fail",
            "timeout_key": "validate_data",
            "func": run_validate_data,
        },
        {
            "name": "transform",
            "pending_state": "pending_transform",
            "running_state": "running_transform",
            "trigger": "start_transform",
            "complete_trigger": "transform_complete",
            "reject_trigger": "transform_reject",
            "retry_target": "extract",
            "fail_trigger": "transform_fail",
            "timeout_key": "transform",
            "func": run_transform,
        },
        {
            "name": "load",
            "pending_state": "pending_load",
            "running_state": "running_load",
            "trigger": "start_load",
            "complete_trigger": "load_complete",
            "fail_trigger": "load_fail",
            "timeout_key": "load",
            "func": run_load,
        },
    ],
    "initial_state": "pending_extract",
    "terminal_states": ["completed", "completed_partial", "cancelled"],
    # 手写转换表：前向跳转 + 驳回
    "transitions": {
        # extract
        "pending_extract": [("start_extract", "running_extract"), ("cancel", "cancelled")],
        "running_extract": [("extract_complete", "pending_validate_data"), ("extract_fail", "pending_extract"), ("cancel", "cancelled")],
        # validate_data（含前向跳转 validate_skip → pending_load）
        "pending_validate_data": [("start_validate_data", "running_validate_data"), ("cancel", "cancelled")],
        "running_validate_data": [
            ("validate_data_complete", "pending_transform"),
            ("validate_skip", "pending_load"),
            ("validate_data_fail", "pending_validate_data"),
            ("cancel", "cancelled"),
        ],
        # transform（含驳回到 extract）
        "pending_transform": [("start_transform", "running_transform"), ("cancel", "cancelled")],
        "running_transform": [
            ("transform_complete", "pending_load"),
            ("transform_reject", "transform_rejected"),
            ("transform_fail", "pending_transform"),
            ("cancel", "cancelled"),
        ],
        "transform_rejected": [("retry_extract", "pending_extract"), ("cancel", "cancelled")],
        # load
        "pending_load": [("start_load", "running_load"), ("cancel", "cancelled")],
        "running_load": [
            ("load_complete", "completed"),
            ("load_partial", "completed_partial"),
            ("load_fail", "pending_load"),
            ("cancel", "cancelled"),
        ],
    },
}
