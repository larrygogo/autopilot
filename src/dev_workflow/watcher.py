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

from scripts.workflow.db import get_active_tasks, get_task, get_conn, now
from scripts.workflow.runner import is_locked, execute_phase, notify
from scripts.workflow.state_machine import VALID_TRANSITIONS

STUCK_TIMEOUT_SECONDS = 600  # 10 分钟没有进展认为卡死

# 运行中的状态 → 对应的 phase
RUNNING_STATE_PHASE = {
    'designing':     'design',
    'reviewing':     'review',
    'in_development': 'dev',
    'code_reviewing': 'code_review',
}

# 等待中的状态 → 对应的 phase（正常情况下 push 模型会自动推进，这里是兜底）
PENDING_STATE_PHASE = {
    'pending_design': 'design',
    'pending_review': 'review',
    'developing':     'dev',
}


def is_stuck(task):
    """判断任务是否卡死"""
    status = task['status']
    if status not in RUNNING_STATE_PHASE and status not in PENDING_STATE_PHASE:
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


# running 状态 → 回退到哪个 pending 状态（用于卡死恢复）
RUNNING_TO_PENDING = {
    'designing':     'pending_design',
    'reviewing':     'pending_review',
    'in_development': 'developing',
    'code_reviewing': None,  # code_reviewing 无对应 pending，回退到 developing 重新开发
}

# running 状态 → 回退时需要的 trigger（回退本身不走状态机，直接改 DB）
RUNNING_FAIL_TRIGGER = {
    'designing':     'design_fail',
    'reviewing':     None,  # 无 fail trigger，直接改状态
    'in_development': 'dev_fail',
    'code_reviewing': None,
}

def recover_task(task):
    """尝试恢复卡死的任务"""
    status = task['status']
    task_id = task['id']

    phase = RUNNING_STATE_PHASE.get(status) or PENDING_STATE_PHASE.get(status)
    if not phase:
        return

    failure_count = task.get('failure_count', 0) + 1
    print(f'[{task_id}] 检测到卡死（{status}），尝试恢复（第{failure_count}次）', file=sys.stderr)

    # 更新失败计数
    with get_conn() as conn:
        conn.execute('UPDATE tasks SET failure_count = ?, updated_at = ? WHERE id = ?',
                     (failure_count, now(), task_id))

    if failure_count >= 3:
        print(f'[{task_id}] 失败次数过多，通知用户', file=sys.stderr)
        notify(task, f'⚠️ 任务卡死：《{task["title"]}》\n\n状态：{status}，已失败 {failure_count} 次。请人工检查。')
        return

    # running 状态：先回退到 pending，再重新触发
    if status in RUNNING_STATE_PHASE:
        fail_trigger = RUNNING_FAIL_TRIGGER.get(status)
        if fail_trigger:
            try:
                from scripts.workflow.state_machine import transition
                transition(task_id, fail_trigger, note=f'卡死恢复（第{failure_count}次）')
                print(f'[{task_id}] 触发 {fail_trigger}，状态回退', file=sys.stderr)
            except Exception as e:
                print(f'[{task_id}] 回退失败：{e}，直接强制改状态', file=sys.stderr)
                pending = RUNNING_TO_PENDING.get(status, 'pending_design')
                with get_conn() as conn:
                    conn.execute('UPDATE tasks SET status = ?, updated_at = ?, started_at = ? WHERE id = ?',
                                 (pending, now(), now(), task_id))
        else:
            # 无 fail trigger 的 running 状态，直接强制改回 pending
            pending = RUNNING_TO_PENDING.get(status) or 'developing'
            print(f'[{task_id}] 强制回退 {status} → {pending}', file=sys.stderr)
            with get_conn() as conn:
                conn.execute('UPDATE tasks SET status = ?, updated_at = ?, started_at = ? WHERE id = ?',
                             (pending, now(), now(), task_id))

        # 回退后重新触发对应 phase
        task = get_task(task_id)  # 重新读取，状态已更新
        execute_phase(task_id, phase)
        return

    # pending 状态：直接重新触发
    if status in PENDING_STATE_PHASE:
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
            if status in PENDING_STATE_PHASE and not is_locked(task['id']):
                from datetime import timezone as tz
                started_at = task.get('started_at') or task.get('updated_at')
                if started_at:
                    started = datetime.fromisoformat(started_at)
                    if started.tzinfo is None:
                        started = started.replace(tzinfo=tz.utc)
                    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
                    # 等待超过 3 分钟还没有推进（push 可能失败了）
                    if elapsed > 180:
                        phase = PENDING_STATE_PHASE[status]
                        print(f'[{task["id"]}] pending 状态超时，重新触发 {phase}', file=sys.stderr)
                        execute_phase(task['id'], phase)


if __name__ == '__main__':
    main()
