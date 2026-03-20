"""通知系统：多后端通知分发
Notification system: multi-backend notification dispatch.

支持 webhook 和 command 两种后端，通过工作流 WORKFLOW['notify_backends'] 配置。
Supports webhook and command backends, configured via WORKFLOW['notify_backends']."""

from __future__ import annotations

import os
import re
import shlex
import ssl
import subprocess
import urllib.request
from typing import Any

from core.logger import get_logger

log = get_logger()


def expand_env_vars(value: str) -> str:
    """展开字符串中的 ${VAR} 环境变量引用
    Expand ${VAR} environment variable references in string."""

    def _replace(m: re.Match) -> str:
        var_name = m.group(1)
        val = os.environ.get(var_name)
        if val is None:
            log.warning("环境变量未设置：%s", var_name)
            return m.group(0)  # 保持原样 / Keep original
        return val

    return re.sub(r"\$\{(\w+)}", _replace, value)


def render_template(template: str, variables: dict[str, str]) -> str:
    """两遍渲染模板
    Two-pass template rendering.

    1. 条件块 / Conditional blocks: {{#var}}content{{/var}} — 变量有值时渲染 content，否则移除整个块
       Render content when variable has value, otherwise remove entire block
    2. 变量替换 / Variable substitution: {{var}} → value
    """
    result = template

    # 第一遍：条件块 / First pass: conditional blocks
    def _replace_block(m: re.Match) -> str:
        var_name = m.group(1)
        block_content = m.group(2)
        val = variables.get(var_name, "")
        if val:
            # 递归渲染块内的变量 / Recursively render variables within block
            return render_template(block_content, variables)
        return ""

    result = re.sub(r"\{\{#(\w+)}}(.*?)\{\{/\1}}", _replace_block, result, flags=re.DOTALL)

    # 第二遍：变量替换 / Second pass: variable substitution
    def _replace_var(m: re.Match) -> str:
        var_name = m.group(1)
        return variables.get(var_name, "")

    result = re.sub(r"\{\{(\w+)}}", _replace_var, result)

    return result


def _matches_event(backend: dict, event: str) -> bool:
    """检查后端是否接收指定事件
    Check if backend accepts the specified event."""
    events = backend.get("events")
    if events is None:
        return True  # 未配置 events 表示全部接收 / No events config means accept all
    if not events:
        return False  # 空列表不匹配任何事件 / Empty list matches no events
    if "*" in events:
        return True
    return event in events


def _send_webhook(backend: dict, variables: dict[str, str]) -> None:
    """通过 HTTP 发送 webhook 通知
    Send webhook notification via HTTP."""
    url = expand_env_vars(backend["url"])
    method = backend.get("method", "POST").upper()
    headers = {}
    for k, v in (backend.get("headers") or {}).items():
        headers[k] = expand_env_vars(v)

    body_template = backend.get("body", "")
    body = render_template(expand_env_vars(body_template), variables)

    try:
        req = urllib.request.Request(
            url,
            data=body.encode("utf-8") if body else None,
            headers=headers,
            method=method,
        )
        ctx = ssl.create_default_context()
        try:
            import certifi

            ctx.load_verify_locations(certifi.where())
        except ImportError:
            pass
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            log.debug("webhook %s 响应：%d", backend.get("name", ""), resp.status)
    except Exception as e:
        log.error("webhook %s 发送失败：%s", backend.get("name", ""), e)


def _send_command(backend: dict, variables: dict[str, str]) -> None:
    """通过 shell 命令发送通知
    Send notification via shell command."""
    cmd_template = backend.get("command", "")
    # 先用原始值处理条件块（判断有无值），再用转义值替换变量（防止命令注入）
    # First process conditional blocks with raw values (check presence), then substitute with escaped values
    safe_variables = {k: shlex.quote(v) if v else "" for k, v in variables.items()}
    cmd = render_template(cmd_template, safe_variables)

    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            log.error("command %s 执行失败（rc=%d）：%s", backend.get("name", ""), r.returncode, r.stderr[:200])
        else:
            log.debug("command %s 执行成功", backend.get("name", ""))
    except Exception as e:
        log.error("command %s 执行异常：%s", backend.get("name", ""), e)


def dispatch(
    task: dict,
    message: str,
    event: str = "info",
    media_path: str | None = None,
    extra_vars: dict[str, str] | None = None,
) -> bool:
    """从工作流注册表获取 notify_backends，匹配事件后分发。
    Retrieve notify_backends from workflow registry, match events, and dispatch.

    Returns:
        True 如果至少有一个后端被调用，False 如果没有配置后端
        True if at least one backend was called, False if no backends configured.
    """
    workflow_name = task.get("workflow", "")
    backends = None
    try:
        from core import registry

        wf = registry.get_workflow(workflow_name)
        if wf:
            backends = wf.get("notify_backends")
    except Exception:
        pass

    if not backends:
        return False

    # 构建模板变量 / Build template variables
    variables: dict[str, str] = {
        "message": message,
        "event": event,
        "task_id": task.get("id", ""),
        "title": task.get("title", ""),
        "workflow": task.get("workflow", ""),
        "status": task.get("status", ""),
        "target": task.get("notify_target", ""),
        "channel": task.get("channel", ""),
        "media_path": media_path or "",
        "media_name": os.path.basename(media_path) if media_path else "",
    }
    if extra_vars:
        variables.update(extra_vars)

    dispatched = False
    for backend in backends:
        if not _matches_event(backend, event):
            continue

        backend_type = backend.get("type", "")
        try:
            if backend_type == "webhook":
                _send_webhook(backend, variables)
                dispatched = True
            elif backend_type == "command":
                _send_command(backend, variables)
                dispatched = True
            else:
                from core.plugin import get_notify_backend

                plugin_handler = get_notify_backend(backend_type)
                if plugin_handler:
                    plugin_handler(backend, variables)
                    dispatched = True
                else:
                    log.warning("未知通知后端类型：%s（%s）", backend_type, backend.get("name", ""))
        except Exception as e:
            log.error("通知后端 %s 异常：%s", backend.get("name", ""), e)

    return dispatched


def validate_backends(backends: Any) -> tuple[list[str], list[str]]:
    """校验 notify_backends 配置。
    Validate notify_backends configuration.

    Returns:
        (errors, warnings)
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(backends, list):
        errors.append("notify_backends 必须是列表")
        return errors, warnings

    from core.plugin import get_all_notify_backend_types

    valid_types = {"webhook", "command"} | get_all_notify_backend_types()
    valid_events = {"progress", "success", "error", "info", "*"}

    for i, backend in enumerate(backends):
        prefix = f"notify_backends[{i}]"

        if not isinstance(backend, dict):
            errors.append(f"{prefix} 必须是字典")
            continue

        # type 必填 / type is required
        backend_type = backend.get("type")
        if not backend_type:
            errors.append(f"{prefix} 缺少 type 字段")
        elif backend_type not in valid_types:
            errors.append(f"{prefix} type 无效：{backend_type}，可选：{valid_types}")

        # webhook 必须有 url / webhook requires url
        if backend_type == "webhook" and not backend.get("url"):
            errors.append(f"{prefix} webhook 类型缺少 url 字段")

        # command 必须有 command / command type requires command field
        if backend_type == "command" and not backend.get("command"):
            errors.append(f"{prefix} command 类型缺少 command 字段")

        # events 校验 / Validate events
        events = backend.get("events")
        if events is not None:
            if not isinstance(events, list):
                errors.append(f"{prefix}.events 必须是列表")
            else:
                for ev in events:
                    if ev not in valid_events:
                        warnings.append(f"{prefix}.events 包含未知事件：{ev}")

    return errors, warnings
