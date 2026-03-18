#!/usr/bin/env python3
"""
查看任务详情。
用法：
  python bin/show_task.py <task_id> [--logs 10]
"""
import sys, argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import init_db, get_task, get_task_logs


def main():
    parser = argparse.ArgumentParser(description='查看任务详情')
    parser.add_argument('task_id', help='任务 ID')
    parser.add_argument('--logs', type=int, default=10, help='显示最近日志条数（默认 10）')
    args = parser.parse_args()

    init_db()
    import core.workflows  # noqa: F401

    task = get_task(args.task_id)
    if not task:
        print(f'任务不存在：{args.task_id}')
        sys.exit(1)

    # 基本信息
    print(f'任务 ID:    {task["id"]}')
    print(f'标题:       {task["title"]}')
    print(f'工作流:     {task["workflow"]}')
    print(f'项目:       {task["project"]}')
    print(f'状态:       {task["status"]}')
    print(f'分支:       {task["branch"]}')
    if task.get('pr_url'):
        print(f'PR:         {task["pr_url"]}')
    print(f'创建时间:   {task["created_at"]}')
    print(f'更新时间:   {task["updated_at"]}')

    # 驳回/失败计数
    failure_count = task.get('failure_count', 0)
    rejection_count = task.get('rejection_count', 0)
    if failure_count or rejection_count:
        print(f'\n失败次数:   {failure_count}')
        print(f'驳回次数:   {rejection_count}')

    # 锁状态
    from core.infra import is_locked
    locked = is_locked(args.task_id)
    print(f'\n锁状态:     {"已锁定（有进程运行中）" if locked else "未锁定"}')

    # 可用操作
    from core.state_machine import get_available_triggers
    triggers = get_available_triggers(args.task_id)
    if triggers:
        print(f'可用操作:   {", ".join(triggers)}')
    else:
        print('可用操作:   无（终态或无转换）')

    # 最近日志
    logs = get_task_logs(args.task_id, limit=args.logs)
    if logs:
        print(f'\n最近 {len(logs)} 条状态变更日志:')
        print(f'  {"时间":<26} {"从":<20} {"到":<20} {"触发器":<16} {"备注"}')
        for log_entry in logs:
            from_s = log_entry.get('from_status') or '-'
            to_s = log_entry['to_status']
            trigger = log_entry.get('trigger') or '-'
            note = log_entry.get('note') or ''
            print(f'  {log_entry["created_at"]:<26} {from_s:<20} {to_s:<20} {trigger:<16} {note}')


if __name__ == '__main__':
    main()
