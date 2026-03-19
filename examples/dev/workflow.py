"""
完整开发工作流：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交
自包含：业务常量、辅助函数、阶段函数均在本模块内
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from core import AUTOPILOT_HOME
from core.db import CONFIG, get_conn, get_default_branch, get_task, now
from core.infra import get_task_dir
from core.logger import get_logger
from core.state_machine import transition

log = get_logger()

# ──────────────────────────────────────────────────────────
# 自管理配置（从全局 CONFIG 读取，有默认值）
# ──────────────────────────────────────────────────────────

_rq_cfg = CONFIG.get("reqgenie", {})
REQGENIE_BASE_URL = os.environ.get("REQGENIE_BASE_URL") or _rq_cfg.get("base_url", "https://reqgenie.reverse-game.ltd")
REQGENIE_MCP_URL = f"{REQGENIE_BASE_URL}/mcp"
REQGENIE_REQ_URL = f"{REQGENIE_BASE_URL}/requirements"
OP_VAULT = os.environ.get("OP_VAULT") or _rq_cfg.get("op_vault", "openclaw")
OP_REQGENIE_ITEM = os.environ.get("OP_REQGENIE_ITEM") or _rq_cfg.get("op_item", "reqgenie 需求系统")

_notify_cfg = CONFIG.get("notify", {})
DEFAULT_NOTIFY_CHANNEL = _notify_cfg.get("channel", "telegram")
DEFAULT_NOTIFY_TARGET = _notify_cfg.get("target", "")

_timeout_cfg = CONFIG.get("timeouts", {})
TIMEOUT_DESIGN = _timeout_cfg.get("design", 900)
TIMEOUT_REVIEW = _timeout_cfg.get("review", 900)
TIMEOUT_DEV = _timeout_cfg.get("development", 1800)
TIMEOUT_CODE_REVIEW = _timeout_cfg.get("code_review", 1200)
TIMEOUT_PR_DESC = _timeout_cfg.get("pr_description", 300)

REVIEW_RESULT_PASS = "REVIEW_RESULT: PASS"
REVIEW_RESULT_REJECT = "REVIEW_RESULT: REJECT"

PROMPTS_DIR = Path(__file__).parent.parent.parent / "prompts"

# ──────────────────────────────────────────────────────────
# 自包含辅助函数
# ──────────────────────────────────────────────────────────

PROJECTS_DIR = AUTOPILOT_HOME / "runtime/projects"


def _run_git(args: list[str], cwd: str, check: bool = True) -> subprocess.CompletedProcess:
    """执行 git 命令，失败时抛出有意义的异常"""
    cmd_str = " ".join(["git"] + args)
    log.debug("执行: %s (cwd=%s)", cmd_str, cwd)
    r = subprocess.run(["git"] + args, capture_output=True, text=True, cwd=cwd, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError(f"git 命令失败：{cmd_str}\nstderr: {r.stderr.strip()}")
    return r


def run_claude(prompt: str, repo_path: str | None = None, timeout: int = 900) -> str:
    """调用 Claude CLI 执行 AI 任务（工作流专属，非框架核心）"""
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


def fetch_req(req_id: str) -> dict | None:
    """从 ReqGenie 拉取需求"""
    try:
        key_r = subprocess.run(
            ["op", "item", "get", OP_REQGENIE_ITEM, "--vault", OP_VAULT, "--fields", "label=api_key"],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        log.warning("op CLI 未安装，跳过 ReqGenie")
        return None
    if key_r.returncode != 0:
        return None
    key = key_r.stdout.strip()
    cfg = {"mcpServers": {"reqgenie": {"baseUrl": REQGENIE_MCP_URL, "headers": {"Authorization": f"Bearer {key}"}}}}
    with tempfile.TemporaryDirectory() as tmpdir:
        cfg_path = os.path.join(tmpdir, "config.json")
        out_path = os.path.join(tmpdir, "result.json")
        with open(cfg_path, "w") as f:
            json.dump(cfg, f)
        r = subprocess.run(
            f"mcporter --config {cfg_path} call reqgenie.get_requirement id={req_id} --output json > {out_path}",
            shell=True,
            timeout=60,
        )
        if r.returncode == 0 and Path(out_path).exists():
            data = json.loads(Path(out_path).read_text(encoding="utf-8"))
            return data.get("data", data) if "id" not in data else data
    return None


def notify_dev(task: dict, message: str, media_path: str | None = None) -> None:
    """dev 工作流通知（通过 openclaw CLI）"""
    target = task.get("notify_target", "")
    channel = task.get("channel", "telegram")
    try:
        subprocess.run(
            ["openclaw", "message", "send", "--channel", channel, "--target", target, "--message", message], check=False
        )
        if media_path and Path(media_path).exists():
            subprocess.run(
                [
                    "openclaw",
                    "message",
                    "send",
                    "--channel",
                    channel,
                    "--target",
                    target,
                    "--media",
                    media_path,
                    "--message",
                    Path(media_path).name,
                ],
                check=False,
            )
    except FileNotFoundError:
        log.warning("openclaw 未安装，通知跳过：%s", message[:80])


def setup_dev_task(args) -> dict:
    """dev 工作流的任务初始化钩子"""
    projects_cfg = CONFIG.get("projects", {})
    project_name = args.project or (list(projects_cfg.keys())[0] if projects_cfg else "unknown")
    project_cfg = projects_cfg.get(project_name, {})
    repo_path = args.repo or project_cfg.get("repo_path", "")
    if repo_path:
        repo_path = str(Path(repo_path).expanduser())

    agents_cfg = CONFIG.get("agents", {}).get("default", {})
    agents = {
        "planDesign": agents_cfg.get("plan_design", "claude"),
        "planReview": agents_cfg.get("plan_review", "codex"),
        "development": agents_cfg.get("development", "claude"),
        "codeReview": agents_cfg.get("code_review", "codex"),
    }

    title = args.title or f"需求 {args.req_id[:8]}"
    try:
        req = fetch_req(args.req_id)
        if req:
            title = req.get("title", title)
    except Exception:
        pass

    return {
        "req_id": args.req_id,
        "title": title,
        "project": project_name,
        "repo_path": repo_path,
        "branch": f"feat/{project_name}-{args.req_id[:8]}",
        "agents": agents,
        "notify_target": DEFAULT_NOTIFY_TARGET,
        "channel": DEFAULT_NOTIFY_CHANNEL,
    }


# ──────────────────────────────────────────────────────────
# 内部辅助
# ──────────────────────────────────────────────────────────


def _get_rejection_counts(task: dict) -> dict:
    """从任务中获取驳回计数字典"""
    raw = task.get("rejection_counts", "{}")
    if not raw:
        raw = "{}"
    try:
        counts = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        counts = {
            "design": task.get("rejection_count", 0) or 0,
            "code": task.get("code_rejection_count", 0) or 0,
        }
    return counts


def _get_phase_config(task: dict, phase_name: str, key: str, default):
    """从工作流定义中获取阶段配置值"""
    from core.registry import get_phase

    workflow = task.get("workflow", "dev")
    phase = get_phase(workflow, phase_name)
    if phase:
        return phase.get(key, default)
    return default


def _notify(task: dict, message: str, media_path: str | None = None, event: str = "info") -> None:
    """通知快捷方式：通过框架 notify 分发"""
    from core.infra import notify

    notify(task, message, media_path, event=event)


# ──────────────────────────────────────────────────────────
# 阶段函数
# ──────────────────────────────────────────────────────────


def run_plan_design(task_id: str) -> None:
    """方案设计"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]

    default_branch = get_default_branch(task["project"])
    _run_git(["checkout", default_branch], cwd=repo_path)
    _run_git(["pull", "--ff-only"], cwd=repo_path)

    req = fetch_req(task["req_id"])
    if not req:
        local_req_path = task_dir / "requirement.md"
        if local_req_path.exists():
            log.info("ReqGenie 不可用，使用本地需求文件")
            req = {"description": local_req_path.read_text(encoding="utf-8"), "organized_content": {}}
        else:
            raise RuntimeError(
                f"无法拉取需求详情，且本地文件 {local_req_path} 不存在。可将需求内容写入该文件作为 fallback。"
            )

    rejection_history = ""
    review_path = task_dir / "plan_review.md"
    rejection_counts = _get_rejection_counts(task)
    design_rejections = rejection_counts.get("design", 0)
    if review_path.exists() and design_rejections > 0:
        prev_review = review_path.read_text(encoding="utf-8")
        rejection_history = f"\n## 上一次评审的驳回意见（第{design_rejections}次驳回）\n{prev_review}"

    template = (PROMPTS_DIR / "plan-design.md").read_text(encoding="utf-8")
    description = req.get("description", "")
    org = req.get("organized_content") or {}
    acceptance = "\n".join(org.get("acceptance_criteria", []))

    knowledge = ""
    knowledge_path = PROJECTS_DIR / task["project"] / "knowledge.md"
    if knowledge_path.exists():
        knowledge = knowledge_path.read_text(encoding="utf-8")

    prompt = template
    for k, v in {
        "{{project}}": task["project"],
        "{{tech_stack}}": "Rust (backend) + TypeScript/React (frontend) + PostgreSQL",
        "{{repo_path}}": repo_path,
        "{{title}}": task["title"],
        "{{url}}": f"{REQGENIE_REQ_URL}/{task['req_id']}",
        "{{description}}": description,
        "{{acceptance_criteria}}": acceptance,
    }.items():
        prompt = prompt.replace(k, v)
    prompt = prompt.replace(
        "{{#knowledge}}\n项目知识库：\n{{knowledge}}\n{{/knowledge}}", f"项目知识库：\n{knowledge}" if knowledge else ""
    )
    if rejection_history:
        prompt += rejection_history

    result = run_claude(prompt, repo_path, timeout=TIMEOUT_DESIGN)

    plan_path = task_dir / "plan.md"
    plan_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    transition(task_id, "design_complete", note="方案设计完成")
    _notify(task, f"📋 方案设计完成：《{task['title']}》\n\n等待方案评审...", str(plan_path))
    from core.runner import run_in_background

    run_in_background(task_id, "review")


def run_plan_review(task_id: str) -> None:
    """方案评审"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]

    plan_content = (task_dir / "plan.md").read_text(encoding="utf-8")
    template = (PROMPTS_DIR / "plan-review.md").read_text(encoding="utf-8")
    prompt = template.replace("{{title}}", task["title"])
    prompt = prompt.replace("{{url}}", f"{REQGENIE_REQ_URL}/{task['req_id']}")
    prompt = prompt.replace("{{plan_content}}", plan_content)

    result = run_claude(prompt, repo_path, timeout=TIMEOUT_REVIEW)

    review_path = task_dir / "plan_review.md"
    review_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    passed = REVIEW_RESULT_PASS in result
    rejected = REVIEW_RESULT_REJECT in result

    if passed:
        transition(task_id, "review_pass", note="方案评审通过")
        _notify(task, f"✅ 方案评审通过：《{task['title']}》\n\n开始开发...", str(review_path))
        from core.runner import run_in_background

        run_in_background(task_id, "dev")

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
            msg = f"⚠️ 方案评审驳回 {new_count} 次：《{task['title']}》\n\n已超过上限，任务取消。"
            _notify(task, msg, str(review_path))
        else:
            transition(
                task_id,
                "review_reject",
                note=f"方案评审驳回（第{new_count}次）",
                extra_updates={"rejection_counts": json.dumps(rejection_counts), "rejection_reason": reason},
            )
            transition(task_id, "retry_design", note=f"自动重新设计（第{new_count}次驳回）")
            msg = f"❌ 方案评审驳回（第{new_count}次）：《{task['title']}》\n\n自动重新设计..."
            _notify(task, msg, str(review_path))
            from core.runner import run_in_background

            run_in_background(task_id, "design")
    else:
        raise RuntimeError("无法解析评审结论，请检查报告")


def run_development(task_id: str) -> None:
    """开发执行"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]
    branch = task["branch"]

    default_branch = get_default_branch(task["project"])
    _run_git(["checkout", default_branch], cwd=repo_path)
    _run_git(["pull", "--ff-only"], cwd=repo_path)
    r = _run_git(["checkout", "-b", branch], cwd=repo_path, check=False)
    if r.returncode != 0:
        _run_git(["checkout", branch], cwd=repo_path)

    plan_content = (task_dir / "plan.md").read_text(encoding="utf-8")
    template = (PROMPTS_DIR / "development.md").read_text(encoding="utf-8")
    prompt = template
    for k, v in {
        "{{project}}": task["project"],
        "{{repo_path}}": repo_path,
        "{{branch}}": branch,
        "{{title}}": task["title"],
        "{{url}}": f"{REQGENIE_REQ_URL}/{task['req_id']}",
        "{{plan_content}}": plan_content,
    }.items():
        prompt = prompt.replace(k, v)
    prompt = prompt.replace("{{#knowledge}}\n项目知识库：\n{{knowledge}}\n{{/knowledge}}", "")

    result = run_claude(prompt, repo_path, timeout=TIMEOUT_DEV)

    report_path = task_dir / "dev_report.md"
    report_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    status_r = _run_git(["status", "--porcelain"], cwd=repo_path)
    if status_r.stdout.strip():
        _run_git(["add", "-A"], cwd=repo_path)
        _run_git(["commit", "-m", f"feat: {task['title']}"], cwd=repo_path)
        log.info("已提交代码变更")
    else:
        log.warning("Claude 未产生代码变更")

    transition(task_id, "dev_complete", note="开发完成")
    _notify(task, f"🔨 开发完成：《{task['title']}》\n\n启动代码审查...", str(report_path))

    from core.runner import run_in_background

    run_in_background(task_id, "code_review")


def run_code_review(task_id: str) -> None:
    """代码审查"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]

    default_branch = get_default_branch(task["project"])
    r = _run_git(["diff", f"{default_branch}...HEAD", "--no-ext-diff"], cwd=repo_path)
    git_diff = r.stdout[:80000]

    plan_content = (task_dir / "plan.md").read_text(encoding="utf-8")
    template = (PROMPTS_DIR / "code-review.md").read_text(encoding="utf-8")
    prompt = template
    for k, v in {
        "{{title}}": task["title"],
        "{{url}}": f"{REQGENIE_REQ_URL}/{task['req_id']}",
        "{{plan_content}}": plan_content,
        "{{git_diff}}": git_diff,
    }.items():
        prompt = prompt.replace(k, v)
    prompt = re.sub(r"{{#screenshots}}.*?{{/screenshots}}", "", prompt, flags=re.DOTALL)

    result = run_claude(prompt, repo_path, timeout=TIMEOUT_CODE_REVIEW)

    review_path = task_dir / "code_review_report.md"
    review_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    passed = REVIEW_RESULT_PASS in result
    rejected = REVIEW_RESULT_REJECT in result

    if passed:
        transition(task_id, "code_pass", note="代码审查通过")
        _notify(task, f"✅ 代码审查通过：《{task['title']}》\n\n提交 PR...", str(review_path))
        from core.runner import run_in_background

        run_in_background(task_id, "pr")

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
            msg = f"⚠️ 代码审查驳回 {new_count} 次：《{task['title']}》\n\n已超过上限，任务取消。"
            _notify(task, msg, str(review_path))
        else:
            transition(
                task_id,
                "code_reject",
                note=f"代码审查驳回（第{new_count}次）",
                extra_updates={"rejection_counts": json.dumps(rejection_counts), "rejection_reason": reason},
            )
            transition(task_id, "retry_dev", note=f"自动返工（第{new_count}次驳回）")
            msg = f"❌ 代码审查驳回（第{new_count}次）：《{task['title']}》\n\n自动返工..."
            _notify(task, msg, str(review_path))
            from core.runner import run_in_background

            run_in_background(task_id, "dev")
    else:
        raise RuntimeError("无法解析审查结论，请检查报告")


def run_submit_pr(task_id: str) -> None:
    """提交 PR"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]
    branch = task["branch"]

    _run_git(["push", "-u", "origin", branch], cwd=repo_path)

    plan_file = task_dir / "plan.md"
    plan_content = plan_file.read_text(encoding="utf-8") if plan_file.exists() else ""
    report_file = task_dir / "dev_report.md"
    dev_report = report_file.read_text(encoding="utf-8") if report_file.exists() else ""
    default_branch = get_default_branch(task["project"])
    diff_r = _run_git(["diff", f"{default_branch}...HEAD", "--stat"], cwd=repo_path)
    git_diff = diff_r.stdout[:3000]

    template = (PROMPTS_DIR / "pr-description.md").read_text(encoding="utf-8")
    prompt = template.replace("{{title}}", task["title"])
    prompt = prompt.replace("{{url}}", f"{REQGENIE_REQ_URL}/{task['req_id']}")
    prompt = prompt.replace("{{plan_content}}", plan_content[:4000])
    prompt = prompt.replace("{{dev_report}}", dev_report[:2000])
    prompt = prompt.replace("{{git_diff}}", git_diff)

    name_r = _run_git(["diff", f"{default_branch}...HEAD", "--name-only"], cwd=repo_path)
    has_frontend = any(
        f.endswith((".tsx", ".ts", ".jsx", ".vue", ".css", ".scss", ".less", ".html", ".svelte"))
        for f in name_r.stdout.split("\n")
    )
    if has_frontend:
        prompt = prompt.replace("{{#has_frontend}}\n", "").replace("\n{{/has_frontend}}", "")
        prompt = re.sub(r"{{.has_frontend}}.*?{{/has_frontend}}", "", prompt, flags=re.DOTALL)
    else:
        prompt = re.sub(r"{{#has_frontend}}.*?{{/has_frontend}}", "", prompt, flags=re.DOTALL)
        prompt = prompt.replace("{{^has_frontend}}\n（无前端视觉改动）\n{{/has_frontend}}", "（无前端视觉改动）")

    pr_body = subprocess.run(
        ["claude", "--permission-mode", "bypassPermissions", "--print", prompt],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_PR_DESC,
        cwd=repo_path,
        encoding="utf-8",
        errors="replace",
    )
    body = pr_body.stdout.strip() if pr_body.returncode == 0 else f"完成需求：{task['title']}"

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
        subprocess.run(["gh", "pr", "edit", "--body", body], capture_output=True, cwd=repo_path)
    else:
        r = subprocess.run(
            [
                "gh",
                "pr",
                "create",
                "--title",
                task["title"],
                "--body",
                body,
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

    with get_conn() as conn:
        conn.execute("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?", (pr_url, now(), task_id))

    _notify(task, f"🎉 PR 已提交：《{task['title']}》\n\n{pr_url}")


# ──────────────────────────────────────────────────────────
# 工作流定义（已迁移到 workflow.yaml）
# 保留 WORKFLOW 引用以兼容单文件 Python 模块加载
# ──────────────────────────────────────────────────────────


def _load_workflow_from_yaml():
    """从同目录 workflow.yaml 加载工作流定义"""
    from core.registry import load_yaml_workflow

    mod = load_yaml_workflow(Path(__file__).parent)
    return mod.WORKFLOW if mod else {}


WORKFLOW = _load_workflow_from_yaml()
