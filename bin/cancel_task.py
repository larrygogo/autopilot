#!/usr/bin/env python3
"""
取消指定任务。
用法：python3 bin/cancel_task.py <task_id> [--reason <reason>]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import get_task
from core.infra import notify
from core.state_machine import InvalidTransitionError, transition


def main():
    parser = argparse.ArgumentParser(description="取消任务")
    parser.add_argument("task_id", help="任务 ID")
    parser.add_argument("--reason", default="用户手动取消", help="取消原因")
    args = parser.parse_args()

    # 确保工作流已注册
    import core.workflows  # noqa: F401

    task = get_task(args.task_id)
    if not task:
        print(f"任务不存在：{args.task_id}")
        sys.exit(1)

    # 从 registry 动态获取终态
    from core.registry import get_terminal_states

    terminal_states = set(get_terminal_states(task.get("workflow", "")))
    terminal_states.add("cancelled")  # cancelled 始终是终态

    if task["status"] in terminal_states:
        print(f"任务已处于终态：{task['status']}")
        sys.exit(0)

    try:
        transition(args.task_id, "cancel", note=args.reason)
        print(f"✓ 任务已取消：{args.task_id} — {task['title']}")
        notify(task, f"🚫 任务已取消：《{task['title']}》\n\n原因：{args.reason}")
    except InvalidTransitionError as e:
        print(f"取消失败：{e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
