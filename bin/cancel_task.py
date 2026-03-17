#!/usr/bin/env python3
"""
取消指定任务。
用法：python3 bin/cancel_task.py <task_id> [--reason <reason>]
"""
import sys, argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / 'src'))

from dev_workflow.db import get_task
from dev_workflow.state_machine import transition, InvalidTransitionError
from dev_workflow.infra import notify


def main():
    parser = argparse.ArgumentParser(description='取消开发任务')
    parser.add_argument('task_id', help='任务 ID')
    parser.add_argument('--reason', default='用户手动取消', help='取消原因')
    args = parser.parse_args()

    task = get_task(args.task_id)
    if not task:
        print(f'任务不存在：{args.task_id}')
        sys.exit(1)

    if task['status'] in ('pr_submitted', 'cancelled'):
        print(f'任务已处于终态：{task["status"]}')
        sys.exit(0)

    try:
        transition(args.task_id, 'cancel', note=args.reason)
        print(f'✓ 任务已取消：{args.task_id} — {task["title"]}')
        notify(task, f'🚫 任务已取消：《{task["title"]}》\n\n原因：{args.reason}')
    except InvalidTransitionError as e:
        print(f'取消失败：{e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
