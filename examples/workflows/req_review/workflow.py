"""
需求评审工作流：需求分析 → 需求评审
Requirement review workflow: Requirement Analysis → Requirement Review

展示框架标准模式：读本地需求 → AI 分析 → AI 评审 → PASS/REJECT
Demonstrates standard framework pattern: read local requirement → AI analysis → AI review → PASS/REJECT
"""

from __future__ import annotations

import subprocess

from core.db import now
from core.infra import get_task_dir
from core.logger import get_logger
from core.state_machine import transition

log = get_logger()

REVIEW_RESULT_PASS = "REVIEW_RESULT: PASS"
REVIEW_RESULT_REJECT = "REVIEW_RESULT: REJECT"


# ──────────────────────────────────────────────────────────
# 辅助函数
# Helper functions
# ──────────────────────────────────────────────────────────


def run_claude(prompt: str, timeout: int = 900) -> str:
    """调用 Claude CLI 执行 AI 任务
    Call Claude CLI to execute an AI task."""
    log.info("调用 Claude CLI (timeout=%ds)", timeout)
    try:
        r = subprocess.run(
            ["claude", "--permission-mode", "bypassPermissions", "--print", prompt],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Claude CLI 超时（{timeout}s），prompt 长度 {len(prompt)} 字符")
    if r.returncode != 0:
        raise RuntimeError(f"Claude CLI 失败: {r.stderr[:500]}")
    return r.stdout.strip()


# ──────────────────────────────────────────────────────────
# 阶段函数
# Phase functions
# ──────────────────────────────────────────────────────────


def run_req_analysis(task_id: str) -> None:
    """需求分析：读 requirement.md → 调用 AI 整理 → 保存分析报告
    Requirement analysis: read requirement.md → call AI → save analysis report"""
    task_dir = get_task_dir(task_id)

    req_path = task_dir / "requirement.md"
    if not req_path.exists():
        raise RuntimeError(f"需求文件不存在：{req_path}")
    requirement = req_path.read_text(encoding="utf-8")

    prompt = (
        f"你是一位需求分析专家。请分析以下需求，输出结构化的需求分析报告。\n\n"
        f"## 原始需求\n{requirement}\n\n"
        f"请输出包含以下内容的分析报告：\n"
        f"1. 需求概述\n2. 功能拆解\n3. 验收标准\n4. 风险点\n5. 依赖项"
    )

    result = run_claude(prompt, timeout=900)

    analysis_path = task_dir / "requirement_analysis.md"
    analysis_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    transition(task_id, "req_analysis_complete", note="需求分析完成")
    from core.runner import run_in_background

    run_in_background(task_id, "req_review")


def run_req_review(task_id: str) -> None:
    """需求评审：读分析报告 → 调用 AI 评审 → 判断 PASS/REJECT
    Requirement review: read analysis report → call AI review → determine PASS/REJECT"""
    task_dir = get_task_dir(task_id)

    req_content = (task_dir / "requirement_analysis.md").read_text(encoding="utf-8")

    prompt = (
        f"你是一位需求评审专家。请评审以下需求分析报告。\n\n"
        f"## 需求分析报告\n{req_content}\n\n"
        f"请从以下维度评审：完整性、可行性、清晰度、验收标准。\n\n"
        f"最后必须输出以下结论之一（独占一行）：\n"
        f"- {REVIEW_RESULT_PASS}\n"
        f"- {REVIEW_RESULT_REJECT}\n\n"
        f"如果驳回，请说明具体问题。"
    )

    result = run_claude(prompt, timeout=900)

    review_path = task_dir / "req_review_report.md"
    review_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    if REVIEW_RESULT_PASS in result:
        transition(task_id, "req_review_complete", note="需求评审通过")
    else:
        transition(task_id, "req_review_reject", note="需求评审驳回")
        transition(task_id, "retry_req_analysis", note="自动重新分析需求")
        from core.runner import run_in_background

        run_in_background(task_id, "req_analysis")
