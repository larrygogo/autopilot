#!/usr/bin/env python3
"""
Watcher：异常恢复保底机制（非主流程）
- 检测卡死任务（运行超时 + 无锁文件）
- 重新触发卡住的阶段
由 OpenClaw cron 每 5 分钟调用（不再需要每 2 分钟）
"""
import sys
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dev_workflow.db import get_active_tasks, get_task, get_conn, now
from dev_workflow.infra import is_locked, notify
from dev_workflow.runner import execute_phase
from dev_workflow.logger import get_logger

log = get_logger()

STUCK_TIMEOUT_SECONDS = 600  # 10 分钟没有进展认为卡死


def _get_state_mappings(task: dict) -> tuple[dict, dict]:
    """获取任务对应工作流的状态映射（动态查注册表，fallback 到默认值）"""
    workflow_name = task.get('workflow', 'dev')

    try:
        from dev_workflow import registry
        running_map = registry.get_running_state_phase(workflow_name)
        pending_map = registry.get_pending_state_phase(workflow_name)
        if running_map or pending_map:
            return running_map, pending_map
    except Exception:
        pass

    # fallback 默认值
    running_map = {
        'designing':     'design',
        'reviewing':     'review',
        'in_development': 'dev',
        'code_reviewing': 'code_review',
    }
    pending_map = {
        'pending_design': 'design',
        'pending_review': 'review',
        'developing':     'dev',
    }
    return running_map, pending_map


def is_stuck(task):
    """判断任务是否卡死"""
    status = task['status']
    running_map, pending_map = _get_state_mappings(task)

    if status not in running_map and status not in pending_map:
        return False

    # 如果有锁文件（进程还活着），不算卡死
    if is_locked(task['id']):
        return False

    # 检查更新时间
    started_at = task.get('started_at') or task.get('updated_at')
    if not started_at:
        return False

    try:
        started = datetime.fromisoformat(started_at)
        if started.tzinfo is None:
            from datetime import timezone as tz
            started = started.replace(tzinfo=tz.utc)
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        return elapsed > STUCK_TIMEOUT_SECONDS
    except Exception:
        return False


def _get_fail_trigger(task: dict, status: str) -> str | None:
    """获取 running 状态对应的 fail trigger"""
    workflow_name = task.get('workflow', 'dev')

    try:
        from dev_workflow import registry
        wf = registry.get_workflow(workflow_name)
        if wf:
            for phase in wf['phases']:
                if phase.get('running_state') == status:
                    return phase.get('fail_trigger')
    except Exception:
        pass

    # fallback
    return {
        'designing':     'design_fail',
        'in_development': 'dev_fail',
    }.get(status)


def _get_pending_state(task: dict, status: str) -> str | None:
    """获取 running 状态对应的回退 pending 状态"""
    workflow_name = task.get('workflow', 'dev')

    try:
        from dev_workflow import registry
        wf = registry.get_workflow(workflow_name)
        if wf:
            for phase in wf['phases']:
                if phase.get('running_state') == status:
                    return phase.get('pending_state')
    except Exception:
        pass

    # fallback
    return {
        'designing':     'pending_design',
        'reviewing':     'pending_review',
        'in_development': 'developing',
        'code_reviewing': None,
    }.get(status)


def recover_task(task):
    """尝试恢复卡死的任务"""
    status = task['status']
    task_id = task['id']
    running_map, pending_map = _get_state_mappings(task)

    phase = running_map.get(status) or pending_map.get(status)
    if not phase:
        return

    failure_count = task.get('failure_count', 0) + 1
    log.warning('检测到卡死（%s），尝试恢复（第%d次）', status, failure_count)

    # 更新失败计数
    with get_conn() as conn:
        conn.execute('UPDATE tasks SET failure_count = ?, updated_at = ? WHERE id = ?',
                     (failure_count, now(), task_id))

    if failure_count >= 3:
        log.error('失败次数过多（%d次），通知用户', failure_count)
        notify(task, f'⚠️ 任务卡死：《{task["title"]}》\n\n状态：{status}，已失败 {failure_count} 次。请人工检查。')
        return

    # running 状态：先回退到 pending，再重新触发
    if status in running_map:
        fail_trigger = _get_fail_trigger(task, status)
        if fail_trigger:
            try:
                from dev_workflow.state_machine import transition
                transition(task_id, fail_trigger, note=f'卡死恢复（第{failure_count}次）')
                log.info('触发 %s，状态回退', fail_trigger)
            except Exception as e:
                log.error('回退失败：%s，直接强制改状态', e)
                pending = _get_pending_state(task, status) or 'pending_design'
                with get_conn() as conn:
                    conn.execute('UPDATE tasks SET status = ?, updated_at = ?, started_at = ? WHERE id = ?',
                                 (pending, now(), now(), task_id))
        else:
            # 无 fail trigger 的 running 状态，直接强制改回 pending
            pending = _get_pending_state(task, status) or 'developing'
            log.warning('强制回退 %s → %s', status, pending)
            with get_conn() as conn:
                conn.execute('UPDATE tasks SET status = ?, updated_at = ?, started_at = ? WHERE id = ?',
                             (pending, now(), now(), task_id))

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
            status = task['status']
            _, pending_map = _get_state_mappings(task)
            if status in pending_map and not is_locked(task['id']):
                from datetime import timezone as tz
                started_at = task.get('started_at') or task.get('updated_at')
                if started_at:
                    started = datetime.fromisoformat(started_at)
                    if started.tzinfo is None:
                        started = started.replace(tzinfo=tz.utc)
                    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
                    # 等待超过 3 分钟还没有推进（push 可能失败了）
                    if elapsed > 180:
                        phase = pending_map[status]
                        log.info('pending 状态超时，重新触发 %s', phase)
                        execute_phase(task['id'], phase)


if __name__ == '__main__':
    main()
