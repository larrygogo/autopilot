"""
需求评审工作流：需求分析 → 需求评审
自包含：业务常量、辅助函数、阶段函数均在本模块内
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from core.db import CONFIG, get_task, now
from core.infra import get_task_dir, run_claude
from core.logger import get_logger
from core.state_machine import transition

log = get_logger()

# ──────────────────────────────────────────────────────────
# 自管理配置
# ──────────────────────────────────────────────────────────

_rq_cfg = CONFIG.get("reqgenie", {})
REQGENIE_BASE_URL = os.environ.get("REQGENIE_BASE_URL") or _rq_cfg.get("base_url", "https://reqgenie.reverse-game.ltd")
REQGENIE_MCP_URL = f"{REQGENIE_BASE_URL}/mcp"
REQGENIE_REQ_URL = f"{REQGENIE_BASE_URL}/requirements"
OP_VAULT = os.environ.get("OP_VAULT") or _rq_cfg.get("op_vault", "openclaw")
OP_REQGENIE_ITEM = os.environ.get("OP_REQGENIE_ITEM") or _rq_cfg.get("op_item", "reqgenie 需求系统")

_timeout_cfg = CONFIG.get("timeouts", {})
TIMEOUT_REVIEW = _timeout_cfg.get("review", 900)

REVIEW_RESULT_PASS = "REVIEW_RESULT: PASS"
REVIEW_RESULT_REJECT = "REVIEW_RESULT: REJECT"

PROMPTS_DIR = Path(__file__).parent.parent.parent / "prompts"

# ──────────────────────────────────────────────────────────
# 自包含辅助函数
# ──────────────────────────────────────────────────────────


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


def _notify(task: dict, message: str, media_path: str | None = None, event: str = "info") -> None:
    """通知快捷方式：通过框架 notify 分发"""
    from core.infra import notify

    notify(task, message, media_path, event=event)


# ──────────────────────────────────────────────────────────
# 阶段函数
# ──────────────────────────────────────────────────────────


def run_req_analysis(task_id: str) -> None:
    """需求分析：拉取并整理需求内容"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)

    req = fetch_req(task["req_id"])
    if not req:
        local_req_path = task_dir / "requirement.md"
        if local_req_path.exists():
            log.info("ReqGenie 不可用，使用本地需求文件")
            req = {"description": local_req_path.read_text(encoding="utf-8"), "organized_content": {}}
        else:
            raise RuntimeError(f"无法拉取需求详情，且本地文件 {local_req_path} 不存在。")

    req_path = task_dir / "requirement_analysis.md"
    description = req.get("description", "")
    org = req.get("organized_content") or {}
    acceptance = "\n".join(org.get("acceptance_criteria", []))

    content = f"# 需求分析：{task['title']}\n\n## 描述\n{description}\n\n## 验收标准\n{acceptance}"
    req_path.write_text(f"<!-- generated:{now()} -->\n{content}", encoding="utf-8")

    transition(task_id, "analysis_complete", note="需求分析完成")
    _notify(task, f"📄 需求分析完成：《{task['title']}》\n\n等待需求评审...")
    from core.runner import run_in_background

    run_in_background(task_id, "req_review")


def run_req_review(task_id: str) -> None:
    """需求评审"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)

    req_content = (task_dir / "requirement_analysis.md").read_text(encoding="utf-8")

    template_path = PROMPTS_DIR / "requirement-review.md"
    if template_path.exists():
        template = template_path.read_text(encoding="utf-8")
        prompt = template.replace("{{title}}", task["title"])
        prompt = prompt.replace("{{url}}", f"{REQGENIE_REQ_URL}/{task['req_id']}")
        prompt = prompt.replace("{{requirement_content}}", req_content)
    else:
        prompt = f"请评审以下需求：\n\n{req_content}\n\n请输出 REVIEW_RESULT: PASS 或 REVIEW_RESULT: REJECT"

    result = run_claude(prompt, timeout=TIMEOUT_REVIEW)

    review_path = task_dir / "req_review_report.md"
    review_path.write_text(f"<!-- generated:{now()} -->\n{result}", encoding="utf-8")

    passed = REVIEW_RESULT_PASS in result

    if passed:
        transition(task_id, "req_review_pass", note="需求评审通过")
        _notify(task, f"✅ 需求评审通过：《{task['title']}》", str(review_path))
    else:
        transition(task_id, "req_review_reject", note="需求评审驳回")
        transition(task_id, "retry_req_analysis", note="自动重新分析需求")
        _notify(task, f"❌ 需求评审驳回：《{task['title']}》\n\n自动重新分析...", str(review_path))
        from core.runner import run_in_background

        run_in_background(task_id, "req_analysis")


# ──────────────────────────────────────────────────────────
# 工作流定义
# ──────────────────────────────────────────────────────────

WORKFLOW = {
    "name": "req_review",
    "description": "需求评审流程",
    # 通知后端：未配置 notify_func 时由框架分发
    # "notify_backends": [
    #     {
    #         "name": "telegram",
    #         "type": "webhook",
    #         "url": "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage",
    #         "method": "POST",
    #         "headers": {"Content-Type": "application/json"},
    #         "body": '{"chat_id": "{{target}}", "text": "[{{workflow}}] {{message}}"}',
    #         "events": ["progress", "success", "error"],
    #     },
    # ],
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
            "func": run_req_analysis,
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
            "func": run_req_review,
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
