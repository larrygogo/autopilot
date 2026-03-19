"""
文档生成与评审工作流：极简自动推导示例
展示特性：最小 YAML、reject 语法糖、零手写 transitions、状态全自动推导
"""

from __future__ import annotations

from core.logger import get_logger

log = get_logger()


def run_generate(task_id: str) -> None:
    """生成文档（占位）"""
    log.info("[doc_gen] generate 阶段执行：task=%s", task_id)


def run_review_doc(task_id: str) -> None:
    """评审文档（占位）"""
    log.info("[doc_gen] review_doc 阶段执行：task=%s", task_id)
