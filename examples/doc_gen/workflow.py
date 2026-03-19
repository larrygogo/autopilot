"""
文档生成与评审工作流：极简自动推导示例
展示特性：最小 YAML、reject 语法糖、零手写 transitions、状态全自动推导
"""

from __future__ import annotations

from core.logger import get_logger

log = get_logger()


# ──────────────────────────────────────────────────────────
# 阶段函数
# ──────────────────────────────────────────────────────────


def run_generate(task_id: str) -> None:
    """生成文档（占位）"""
    log.info("[doc_gen] generate 阶段执行：task=%s", task_id)


def run_review_doc(task_id: str) -> None:
    """评审文档（占位）"""
    log.info("[doc_gen] review_doc 阶段执行：task=%s", task_id)


# ──────────────────────────────────────────────────────────
# 工作流定义 — 零手写 transitions，由框架自动推导
# ──────────────────────────────────────────────────────────

WORKFLOW = {
    "name": "doc_gen",
    "description": "文档生成与评审",
    "phases": [
        {
            "name": "generate",
            "pending_state": "pending_generate",
            "running_state": "running_generate",
            "trigger": "start_generate",
            "complete_trigger": "generate_complete",
            "fail_trigger": "generate_fail",
            "timeout_key": "generate",
            "func": run_generate,
        },
        {
            "name": "review_doc",
            "pending_state": "pending_review_doc",
            "running_state": "running_review_doc",
            "trigger": "start_review_doc",
            "complete_trigger": "review_doc_pass",
            "reject_trigger": "review_doc_reject",
            "retry_target": "generate",
            "max_rejections": 5,
            "timeout_key": "review_doc",
            "func": run_review_doc,
        },
    ],
    "initial_state": "pending_generate",
    "terminal_states": ["doc_gen_done", "cancelled"],
}
