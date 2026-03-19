#!/usr/bin/env python3
"""
查询任务列表。
用法：
  python bin/list_tasks.py [--status pending_design] [--workflow dev] [--project myproj] [--limit 20]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import init_db, list_tasks


def main():
    parser = argparse.ArgumentParser(description="查询任务列表")
    parser.add_argument("--status", help="按状态过滤")
    parser.add_argument("--workflow", help="按工作流过滤")
    parser.add_argument("--project", help="按项目过滤")
    parser.add_argument("--limit", type=int, default=50, help="最大返回条数（默认 50）")
    args = parser.parse_args()

    init_db()
    import core.workflows  # noqa: F401

    tasks = list_tasks(
        status=args.status,
        workflow=args.workflow,
        project=args.project,
        limit=args.limit,
    )

    if not tasks:
        print("暂无任务")
        return

    # 表格输出
    header = f"{'ID':<12} {'工作流':<14} {'状态':<20} {'标题':<30} {'更新时间':<26}"
    print(header)
    print("-" * len(header))
    for t in tasks:
        title = t["title"][:28] + ".." if len(t["title"]) > 30 else t["title"]
        print(f"{t['id']:<12} {t['workflow']:<14} {t['status']:<20} {title:<30} {t['updated_at']:<26}")

    print(f"\n共 {len(tasks)} 条")


if __name__ == "__main__":
    main()
