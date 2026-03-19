"""
测试配置：使用内存数据库，每个测试独立初始化
"""

import sqlite3
from types import SimpleNamespace

import pytest


@pytest.fixture(autouse=True)
def _in_memory_db(monkeypatch):
    """每个测试使用独立的内存数据库"""
    import core.db as db_mod

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(db_mod.SCHEMA)

    monkeypatch.setattr(db_mod, "_local", type("FakeLocal", (), {"conn": conn})())
    monkeypatch.setattr(db_mod, "get_conn", lambda: conn)

    yield conn

    conn.close()


def _noop(task_id: str) -> None:
    pass


@pytest.fixture(autouse=True)
def _register_test_workflows():
    """注册测试用工作流（替代已移除的内置工作流）"""
    from core.registry import _registry, register

    old_registry = dict(_registry)

    dev_wf = SimpleNamespace(
        WORKFLOW={
            "name": "dev",
            "description": "完整开发流程",
            "phases": [
                {
                    "name": "design",
                    "label": "PLAN_DESIGN",
                    "trigger": "start_design",
                    "pending_state": "pending_design",
                    "running_state": "designing",
                    "complete_trigger": "design_complete",
                    "fail_trigger": "design_fail",
                    "timeout_key": "design",
                    "func": _noop,
                },
                {
                    "name": "review",
                    "label": "PLAN_REVIEW",
                    "trigger": "start_review",
                    "pending_state": "pending_review",
                    "running_state": "reviewing",
                    "complete_trigger": "review_pass",
                    "reject_trigger": "review_reject",
                    "retry_target": "design",
                    "max_rejections": 10,
                    "timeout_key": "review",
                    "func": _noop,
                },
                {
                    "name": "dev",
                    "label": "DEVELOPMENT",
                    "trigger": "start_dev",
                    "pending_state": "developing",
                    "running_state": "in_development",
                    "complete_trigger": "dev_complete",
                    "fail_trigger": "dev_fail",
                    "timeout_key": "development",
                    "func": _noop,
                },
                {
                    "name": "code_review",
                    "label": "CODE_REVIEW",
                    "trigger": None,
                    "pending_state": "code_reviewing",
                    "running_state": "code_reviewing",
                    "complete_trigger": "code_pass",
                    "reject_trigger": "code_reject",
                    "retry_target": "dev",
                    "max_rejections": 10,
                    "timeout_key": "code_review",
                    "func": _noop,
                },
                {
                    "name": "pr",
                    "label": "SUBMIT_PR",
                    "trigger": None,
                    "pending_state": "pr_submitting",
                    "running_state": "pr_submitting",
                    "complete_trigger": None,
                    "timeout_key": "pr_description",
                    "func": _noop,
                },
            ],
            "initial_state": "pending_design",
            "terminal_states": ["pr_submitted", "cancelled"],
            "transitions": {
                "pending_design": [("start_design", "designing"), ("cancel", "cancelled")],
                "designing": [
                    ("design_complete", "pending_review"),
                    ("design_fail", "pending_design"),
                    ("cancel", "cancelled"),
                ],
                "pending_review": [("start_review", "reviewing"), ("cancel", "cancelled")],
                "reviewing": [
                    ("review_pass", "developing"),
                    ("review_reject", "review_rejected"),
                    ("cancel", "cancelled"),
                ],
                "review_rejected": [("retry_design", "pending_design"), ("cancel", "cancelled")],
                "developing": [("start_dev", "in_development"), ("cancel", "cancelled")],
                "in_development": [
                    ("dev_complete", "code_reviewing"),
                    ("dev_fail", "developing"),
                    ("cancel", "cancelled"),
                ],
                "code_reviewing": [
                    ("code_pass", "pr_submitted"),
                    ("code_reject", "code_rejected"),
                    ("cancel", "cancelled"),
                ],
                "code_rejected": [("retry_dev", "in_development"), ("cancel", "cancelled")],
            },
        }
    )

    req_review_wf = SimpleNamespace(
        WORKFLOW={
            "name": "req_review",
            "description": "需求评审流程",
            "phases": [
                {
                    "name": "req_analysis",
                    "label": "REQ_ANALYSIS",
                    "trigger": "start_analysis",
                    "pending_state": "pending_analysis",
                    "running_state": "analyzing",
                    "complete_trigger": "analysis_complete",
                    "fail_trigger": "analysis_fail",
                    "timeout_key": "review",
                    "func": _noop,
                },
                {
                    "name": "req_review",
                    "label": "REQ_REVIEW",
                    "trigger": "start_req_review",
                    "pending_state": "pending_req_review",
                    "running_state": "req_reviewing",
                    "complete_trigger": "req_review_pass",
                    "reject_trigger": "req_review_reject",
                    "retry_target": "req_analysis",
                    "max_rejections": 5,
                    "timeout_key": "review",
                    "func": _noop,
                },
            ],
            "initial_state": "pending_analysis",
            "terminal_states": ["req_review_done", "cancelled"],
            "transitions": {
                "pending_analysis": [("start_analysis", "analyzing"), ("cancel", "cancelled")],
                "analyzing": [
                    ("analysis_complete", "pending_req_review"),
                    ("analysis_fail", "pending_analysis"),
                    ("cancel", "cancelled"),
                ],
                "pending_req_review": [("start_req_review", "req_reviewing"), ("cancel", "cancelled")],
                "req_reviewing": [
                    ("req_review_pass", "req_review_done"),
                    ("req_review_reject", "req_review_rejected"),
                    ("cancel", "cancelled"),
                ],
                "req_review_rejected": [("retry_req_analysis", "pending_analysis"), ("cancel", "cancelled")],
            },
        }
    )

    register(dev_wf)
    register(req_review_wf)

    yield

    _registry.clear()
    _registry.update(old_registry)
