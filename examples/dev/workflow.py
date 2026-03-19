"""
完整开发工作流：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交
展示框架标准模式：读任务 → 执行 → 保存产出物 → transition → push 下一阶段
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from core.db import CONFIG, get_task, now, update_task
from core.infra import get_task_dir
from core.logger import get_logger
from core.state_machine import transition

log = get_logger()

REVIEW_RESULT_PASS = "REVIEW_RESULT: PASS"
REVIEW_RESULT_REJECT = "REVIEW_RESULT: REJECT"


# ──────────────────────────────────────────────────────────
# 辅助函数
# ──────────────────────────────────────────────────────────


def _run_git(args: list[str], cwd: str, check: bool = True) -> subprocess.CompletedProcess:
    """执行 git 命令"""
    cmd_str = " ".join(["git"] + args)
    log.debug("执行: %s (cwd=%s)", cmd_str, cwd)
    r = subprocess.run(["git"] + args, capture_output=True, text=True, cwd=cwd, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError(f"git 命令失败：{cmd_str}\nstderr: {r.stderr.strip()}")
    return r


def run_claude(prompt: str, repo_path: str | None = None, timeout: int = 900) -> str:
    """调用 Claude CLI 执行 AI 任务"""
    log.info("调用 Claude CLI (timeout=%ds, cwd=%s)", timeout, repo_path or "None")
    try:
        r = subprocess.run(
            ["claude", "--permission-mode", "bypassPermissions", "--print", prompt],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=repo_path if repo_path and Path(repo_path).exists() else None,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Claude CLI 超时（{timeout}s），prompt 长度 {len(prompt)} 字符")
    if r.returncode != 0:
        raise RuntimeError(f"Claude CLI 失败: {r.stderr[:500]}")
    return r.stdout.strip()


def _get_rejection_counts(task: dict) -> dict:
    """从任务中获取驳回计数字典"""
    raw = task.get("rejection_counts", "{}")
    if not raw:
        raw = "{}"
    try:
        counts = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        counts = {}
    return counts


def _get_phase_config(task: dict, phase_name: str, key: str, default):
    """从工作流定义中获取阶段配置值"""
    from core.registry import get_phase

    workflow = task.get("workflow", "dev")
    phase = get_phase(workflow, phase_name)
    if phase:
        return phase.get(key, default)
    return default


# ──────────────────────────────────────────────────────────
# setup
# ──────────────────────────────────────────────────────────


def setup_dev_task(args) -> dict:
    """dev 工作流的任务初始化钩子"""
    repo_path = CONFIG.get("repo_path", "")
    if repo_path:
        repo_path = str(Path(repo_path).expanduser())

    default_branch = CONFIG.get("default_branch", "main")
    title = args.title or "untitled"

    return {
        "title": title,
        "repo_path": repo_path,
        "default_branch": default_branch,
        "branch": f"feat/{title[:20].replace(' ', '-').lower()}",
    }


# ──────────────────────────────────────────────────────────
# 阶段函数
# ──────────────────────────────────────────────────────────


def run_design(task_id: str) -> None:
    """方案设计：读 requirement.md → 调用 AI → 保存 plan.md"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]
    default_branch = task.get("default_branch", "main")

    _run_git(["checkout", default_branch], cwd=repo_path)
    _run_git(["pull", "--ff-only"], cwd=repo_path)

    req_path = task_dir / "requirement.md"
    if not req_path.exists():
        raise RuntimeError(f"需求文件不存在：{req_path}")
    requirement = req_path.read_text(encoding="utf-8")

    # 驳回历史
    rejection_history = ""
    review_path = task_dir / "plan_review.md"
    rejection_counts = _get_rejection_counts(task)
    design_rejections = rejection_counts.get("design", 0)
    if review_path.exists() and design_rejections > 0:
        prev_review = review_path.read_text(encoding="utf-8")
        rejection_history = f"\n\n## 上一次评审的驳回意见（第{design_rejections}次驳回）\n{prev_review}"

    prompt = (
        f"你是一位资深架构师。请根据以下需求，生成一份完整的技术方案。\n\n"
        f"## 需求\n{requirement}\n\n"
        f"## 仓库路径\n{repo_path}\n\n"
        f"请先阅读仓库代码了解项目结构，然后输出包含以下内容的技术方案：\n"
        f"1. 需求分析\n2. 技术方案\n3. 实现步骤\n4. 影响范围\n5. 测试计划"
        f"{rejection_history}"
    )

    result = run_claude(prompt, repo_path, timeout=900)

    plan_path = task_dir / "plan.md"
    plan_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    transition(task_id, "design_complete", note="方案设计完成")
    from core.runner import run_in_background

    run_in_background(task_id, "review")


def run_review(task_id: str) -> None:
    """方案评审：读 plan.md → 调用 AI → 判断 PASS/REJECT"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]

    plan_content = (task_dir / "plan.md").read_text(encoding="utf-8")
    requirement = ""
    req_path = task_dir / "requirement.md"
    if req_path.exists():
        requirement = req_path.read_text(encoding="utf-8")

    prompt = (
        f"你是一位技术评审专家。请评审以下技术方案是否满足需求。\n\n"
        f"## 需求\n{requirement}\n\n"
        f"## 技术方案\n{plan_content}\n\n"
        f"请从以下维度评审：完整性、可行性、风险点、测试覆盖。\n\n"
        f"最后必须输出以下结论之一（独占一行）：\n"
        f"- {REVIEW_RESULT_PASS}\n"
        f"- {REVIEW_RESULT_REJECT}\n\n"
        f"如果驳回，请在 ## 驳回理由 下说明具体问题。"
    )

    result = run_claude(prompt, repo_path, timeout=900)

    review_path = task_dir / "plan_review.md"
    review_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    passed = REVIEW_RESULT_PASS in result
    rejected = REVIEW_RESULT_REJECT in result

    if passed:
        transition(task_id, "review_complete", note="方案评审通过")
        from core.runner import run_in_background

        run_in_background(task_id, "develop")

    elif rejected:
        reason_match = re.search(r"## 驳回理由\n(.*?)(?=\n## |\Z)", result, re.DOTALL)
        reason = reason_match.group(1).strip() if reason_match else "请查看评审报告"
        rejection_counts = _get_rejection_counts(task)
        new_count = rejection_counts.get("design", 0) + 1
        rejection_counts["design"] = new_count

        max_rejections = _get_phase_config(task, "review", "max_rejections", 10)

        if new_count >= max_rejections:
            transition(
                task_id,
                "cancel",
                note=f"方案评审驳回 {new_count} 次，已取消",
                extra_updates={"rejection_counts": json.dumps(rejection_counts), "rejection_reason": reason},
            )
        else:
            transition(
                task_id,
                "review_reject",
                note=f"方案评审驳回（第{new_count}次）",
                extra_updates={"rejection_counts": json.dumps(rejection_counts), "rejection_reason": reason},
            )
            transition(task_id, "retry_design", note=f"自动重新设计（第{new_count}次驳回）")
            from core.runner import run_in_background

            run_in_background(task_id, "design")
    else:
        raise RuntimeError("无法解析评审结论，请检查报告")


def run_develop(task_id: str) -> None:
    """开发执行：读 plan.md → 在 repo 中调用 AI → git commit"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]
    branch = task["branch"]
    default_branch = task.get("default_branch", "main")

    _run_git(["checkout", default_branch], cwd=repo_path)
    _run_git(["pull", "--ff-only"], cwd=repo_path)
    r = _run_git(["checkout", "-b", branch], cwd=repo_path, check=False)
    if r.returncode != 0:
        _run_git(["checkout", branch], cwd=repo_path)

    plan_content = (task_dir / "plan.md").read_text(encoding="utf-8")

    prompt = (
        f"你是一位高级开发工程师。请根据以下技术方案进行开发。\n\n"
        f"## 技术方案\n{plan_content}\n\n"
        f"请直接在仓库中创建和修改文件完成开发，确保代码可编译、可运行。"
    )

    result = run_claude(prompt, repo_path, timeout=1800)

    report_path = task_dir / "dev_report.md"
    report_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    status_r = _run_git(["status", "--porcelain"], cwd=repo_path)
    if status_r.stdout.strip():
        _run_git(["add", "-A"], cwd=repo_path)
        _run_git(["commit", "-m", f"feat: {task['title']}"], cwd=repo_path)

    transition(task_id, "develop_complete", note="开发完成")
    from core.runner import run_in_background

    run_in_background(task_id, "code_review")


def run_code_review(task_id: str) -> None:
    """代码审查：git diff → 调用 AI → 判断 PASS/REJECT"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]
    default_branch = task.get("default_branch", "main")

    r = _run_git(["diff", f"{default_branch}...HEAD", "--no-ext-diff"], cwd=repo_path)
    git_diff = r.stdout[:80000]

    plan_content = (task_dir / "plan.md").read_text(encoding="utf-8")

    prompt = (
        f"你是一位代码审查专家。请审查以下代码变更是否符合技术方案要求。\n\n"
        f"## 技术方案\n{plan_content}\n\n"
        f"## 代码变更\n```diff\n{git_diff}\n```\n\n"
        f"请从以下维度审查：正确性、代码质量、安全性、测试覆盖。\n\n"
        f"最后必须输出以下结论之一（独占一行）：\n"
        f"- {REVIEW_RESULT_PASS}\n"
        f"- {REVIEW_RESULT_REJECT}\n\n"
        f"如果驳回，请在 ## 不通过理由 下说明具体问题。"
    )

    result = run_claude(prompt, repo_path, timeout=1200)

    review_path = task_dir / "code_review_report.md"
    review_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    passed = REVIEW_RESULT_PASS in result
    rejected = REVIEW_RESULT_REJECT in result

    if passed:
        transition(task_id, "code_review_complete", note="代码审查通过")
        from core.runner import run_in_background

        run_in_background(task_id, "submit_pr")

    elif rejected:
        reason_match = re.search(r"## 不通过理由\n(.*?)(?=\n## |\Z)", result, re.DOTALL)
        reason = reason_match.group(1).strip() if reason_match else "请查看审查报告"
        rejection_counts = _get_rejection_counts(task)
        new_count = rejection_counts.get("code", 0) + 1
        rejection_counts["code"] = new_count

        max_rejections = _get_phase_config(task, "code_review", "max_rejections", 10)

        if new_count >= max_rejections:
            transition(
                task_id,
                "cancel",
                note=f"代码审查驳回 {new_count} 次，已取消",
                extra_updates={"rejection_counts": json.dumps(rejection_counts), "rejection_reason": reason},
            )
        else:
            transition(
                task_id,
                "code_review_reject",
                note=f"代码审查驳回（第{new_count}次）",
                extra_updates={"rejection_counts": json.dumps(rejection_counts), "rejection_reason": reason},
            )
            transition(task_id, "retry_develop", note=f"自动返工（第{new_count}次驳回）")
            from core.runner import run_in_background

            run_in_background(task_id, "develop")
    else:
        raise RuntimeError("无法解析审查结论，请检查报告")


def run_submit_pr(task_id: str) -> None:
    """提交 PR：git push → gh pr create"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]
    branch = task["branch"]
    default_branch = task.get("default_branch", "main")

    _run_git(["push", "-u", "origin", branch], cwd=repo_path)

    plan_file = task_dir / "plan.md"
    plan_content = plan_file.read_text(encoding="utf-8") if plan_file.exists() else ""
    diff_r = _run_git(["diff", f"{default_branch}...HEAD", "--stat"], cwd=repo_path)
    git_diff_stat = diff_r.stdout[:3000]

    prompt = (
        f"请根据以下信息生成 PR 描述（Markdown 格式）：\n\n"
        f"## 标题\n{task['title']}\n\n"
        f"## 技术方案摘要\n{plan_content[:4000]}\n\n"
        f"## 变更统计\n{git_diff_stat}\n\n"
        f"请输出完整的 PR body，包含：概述、主要变更、测试说明。"
    )

    pr_body = run_claude(prompt, repo_path, timeout=300)

    # 检查是否已存在 PR
    existing = subprocess.run(
        ["gh", "pr", "view", "--json", "url"],
        capture_output=True,
        text=True,
        cwd=repo_path,
        encoding="utf-8",
        errors="replace",
    )
    if existing.returncode == 0:
        pr_url = json.loads(existing.stdout).get("url", "")
        subprocess.run(["gh", "pr", "edit", "--body", pr_body], capture_output=True, cwd=repo_path)
    else:
        r = subprocess.run(
            [
                "gh",
                "pr",
                "create",
                "--title",
                task["title"],
                "--body",
                pr_body,
                "--base",
                default_branch,
                "--head",
                branch,
            ],
            capture_output=True,
            text=True,
            cwd=repo_path,
            encoding="utf-8",
            errors="replace",
        )
        if r.returncode != 0:
            raise RuntimeError(f"创建 PR 失败：{r.stderr}")
        pr_url = r.stdout.strip()

    update_task(task_id, pr_url=pr_url)
