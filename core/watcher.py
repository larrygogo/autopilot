#!/usr/bin/env python3
"""
Watcher：异常恢复保底机制（非主流程）
- 检测卡死任务（运行超时 + 无锁文件）
- 重新触发卡住的阶段
由 OpenClaw cron 每 5 分钟调用（不再需要每 2 分钟）
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import get_active_tasks, get_conn, get_task, now
from core.infra import is_locked, notify
from core.logger import get_logger
from core.runner import execute_phase

log = get_logger()


def _get_state_mappings(task: dict) -> tuple[dict, dict]:
    """获取任务对应工作流的状态映射（动态查注册表，查不到返回空字典）"""
    workflow_name = task.get("workflow", "")

    try:
        from core import registry

        running_map = registry.get_running_state_phase(workflow_name)
        pending_map = registry.get_pending_state_phase(workflow_name)
        return running_map, pending_map
    except Exception as e:
        log.debug("获取工作流 %s 状态映射失败：%s", workflow_name, e)

    return {}, {}


def _calculate_delay(policy: dict, attempt: int) -> float:
    """根据重试策略和尝试次数计算延迟"""
    if policy.get("backoff") == "exponential":
        return min(policy["delay"] * (2 ** (attempt - 1)), policy["max_delay"])
    return policy["delay"]


def is_stuck(task):
    """判断任务是否卡死"""
    status = task["status"]
    running_map, pending_map = _get_state_mappings(task)

    if status not in running_map and status not in pending_map:
        return False

    # 如果有锁文件（进程还活着），不算卡死
    if is_locked(task["id"]):
        return False

    # 检查更新时间
    started_at = task.get("started_at") or task.get("updated_at")
    if not started_at:
        return False

    # 从策略获取超时值
    workflow_name = task.get("workflow", "")
    phase_name = running_map.get(status) or pending_map.get(status)
    try:
        from core.registry import get_retry_policy

        policy = get_retry_policy(workflow_name, phase_name)
        stuck_timeout = policy["stuck_timeout"]
    except Exception:
        stuck_timeout = 600

    try:
        started = datetime.fromisoformat(started_at)
        if started.tzinfo is None:
            from datetime import timezone as tz

            started = started.replace(tzinfo=tz.utc)
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        return elapsed > stuck_timeout
    except Exception:
        return False


def _get_fail_trigger(task: dict, status: str) -> str | None:
    """获取 running 状态对应的 fail trigger"""
    workflow_name = task.get("workflow", "")

    try:
        from core import registry

        wf = registry.get_workflow(workflow_name)
        if wf:
            for phase in wf["phases"]:
                if phase.get("running_state") == status:
                    return phase.get("fail_trigger")
    except Exception as e:
        log.debug("获取 fail_trigger 失败：%s", e)

    return None


def _get_pending_state(task: dict, status: str) -> str | None:
    """获取 running 状态对应的回退 pending 状态"""
    workflow_name = task.get("workflow", "")

    try:
        from core import registry

        wf = registry.get_workflow(workflow_name)
        if wf:
            for phase in wf["phases"]:
                if phase.get("running_state") == status:
                    return phase.get("pending_state")
    except Exception as e:
        log.debug("获取 pending_state 失败：%s", e)

    return None


def recover_task(task):
    """尝试恢复卡死的任务"""
    status = task["status"]
    task_id = task["id"]
    running_map, pending_map = _get_state_mappings(task)

    phase = running_map.get(status) or pending_map.get(status)
    if not phase:
        log.error("无法确定状态 %s 对应的阶段，跳过恢复", status)
        return

    failure_count = task.get("failure_count", 0) + 1
    log.warning("检测到卡死（%s），尝试恢复（第%d次）", status, failure_count)

    # 更新失败计数
    with get_conn() as conn:
        conn.execute("UPDATE tasks SET failure_count = ?, updated_at = ? WHERE id = ?", (failure_count, now(), task_id))

    # 从策略获取 max_retries
    workflow_name = task.get("workflow", "")
    try:
        from core.registry import get_retry_policy

        policy = get_retry_policy(workflow_name, phase)
        max_retries = policy["max_retries"]
    except Exception:
        max_retries = 3

    if failure_count >= max_retries:
        log.error("失败次数过多（%d次），通知用户", failure_count)
        notify(task, f"⚠️ 任务卡死：《{task['title']}》\n\n状态：{status}，已失败 {failure_count} 次。请人工检查。")
        return

    # running 状态：先回退到 pending，再重新触发
    if status in running_map:
        fail_trigger = _get_fail_trigger(task, status)
        if fail_trigger:
            try:
                from core.state_machine import transition

                transition(task_id, fail_trigger, note=f"卡死恢复（第{failure_count}次）")
                log.info("触发 %s，状态回退", fail_trigger)
            except Exception as e:
                log.error("回退失败：%s，直接强制改状态", e)
                pending = _get_pending_state(task, status)
                if not pending:
                    log.error("无法确定 %s 的回退状态，跳过恢复", status)
                    return

                with get_conn() as conn:
                    conn.execute(
                        "UPDATE tasks SET status = ?, updated_at = ?, started_at = ? WHERE id = ?",
                        (pending, now(), now(), task_id),
                    )
        else:
            # 无 fail trigger 的 running 状态，直接强制改回 pending
            pending = _get_pending_state(task, status)
            if not pending:
                log.error("无法确定 %s 的回退状态，跳过恢复", status)
                return
            log.warning("强制回退 %s → %s", status, pending)
            with get_conn() as conn:
                conn.execute(
                    "UPDATE tasks SET status = ?, updated_at = ?, started_at = ? WHERE id = ?",
                    (pending, now(), now(), task_id),
                )

        # 回退后重新触发对应 phase
        task = get_task(task_id)  # 重新读取，状态已更新
        execute_phase(task_id, phase)
        return

    # pending 状态：直接重新触发
    if status in pending_map:
        execute_phase(task_id, phase)


def main():
    tasks = get_active_tasks()
    if not tasks:
        return

    for task in tasks:
        if is_stuck(task):
            recover_task(task)
        else:
            # 任务正常，检查有没有 pending 状态但没有锁（可能 push 失败了）
            status = task["status"]
            _, pending_map = _get_state_mappings(task)
            if status in pending_map and not is_locked(task["id"]):
                from datetime import timezone as tz

                started_at = task.get("started_at") or task.get("updated_at")
                if started_at:
                    started = datetime.fromisoformat(started_at)
                    if started.tzinfo is None:
                        started = started.replace(tzinfo=tz.utc)
                    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
                    # 从策略获取延迟值
                    phase_name = pending_map[status]
                    workflow_name = task.get("workflow", "")
                    try:
                        from core.registry import get_retry_policy

                        policy = get_retry_policy(workflow_name, phase_name)
                        failure_count = task.get("failure_count", 0)
                        pending_delay = _calculate_delay(policy, max(failure_count, 1))
                    except Exception:
                        pending_delay = 180
                    if elapsed > pending_delay:
                        log.info("pending 状态超时，重新触发 %s", phase_name)
                        execute_phase(task["id"], phase_name)


if __name__ == "__main__":
    main()
