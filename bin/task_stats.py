#!/usr/bin/env python3
"""
任务统计概览。
用法：
  python bin/task_stats.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import get_task_stats, init_db


def main():
    init_db()
    import core.workflows  # noqa: F401

    stats = get_task_stats()

    print(f"任务总数:     {stats['total']}")
    print(f"成功率:       {stats['success_rate']}%")

    avg_dur = stats["avg_duration_seconds"]
    if avg_dur > 3600:
        print(f"平均耗时:     {avg_dur / 3600:.1f} 小时")
    elif avg_dur > 60:
        print(f"平均耗时:     {avg_dur / 60:.1f} 分钟")
    else:
        print(f"平均耗时:     {avg_dur:.0f} 秒")

    if stats["by_status"]:
        print("\n按状态分布:")
        for status, count in sorted(stats["by_status"].items()):
            print(f"  {status:<24} {count}")

    if stats["by_workflow"]:
        print("\n按工作流分布:")
        for wf, count in sorted(stats["by_workflow"].items()):
            print(f"  {wf:<24} {count}")


if __name__ == "__main__":
    main()
