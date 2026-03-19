#!/usr/bin/env python3
"""
注册新任务并启动工作流。
用法：
  python3 bin/start_task.py <req_id> [--project <project>] [--repo <repo_path>]
                                    [--workflow <workflow>] [--title <title>]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import create_task, get_task, init_db
from core.runner import execute_phase


def main():
    parser = argparse.ArgumentParser(description="注册并启动任务")
    parser.add_argument("req_id", help="需求 ID")
    parser.add_argument("--project", help="项目名（对应 config.yaml 中的 projects 配置）")
    parser.add_argument("--repo", help="本地仓库路径（覆盖 config.yaml）")
    parser.add_argument("--title", help="需求标题（可选）")
    parser.add_argument("--workflow", default=None, help="工作流名称")
    args = parser.parse_args()

    init_db()

    # 确保工作流已注册
    import core.workflows  # noqa: F401

    # 自动选择工作流
    from core.registry import get_workflow, list_workflows

    available = list_workflows()

    if args.workflow is None:
        if not available:
            print("没有已注册的工作流，请先将工作流放入 AUTOPILOT_HOME/workflows/ 目录")
            sys.exit(1)
        elif len(available) == 1:
            args.workflow = available[0]["name"]
            print(f"自动选择唯一工作流：{args.workflow}")
        else:
            names = [w["name"] for w in available]
            print(f"有多个工作流可用：{names}，请通过 --workflow 指定")
            sys.exit(1)

    wf = get_workflow(args.workflow)
    if not wf:
        names = [w["name"] for w in available]
        print(f"未知工作流：{args.workflow}，可用工作流：{names}")
        sys.exit(1)

    # 检查是否已注册
    task_id = f"{args.req_id[:8]}"
    existing = get_task(task_id)
    if existing:
        print(f"任务已存在：{task_id}，当前状态：{existing['status']}")
        sys.exit(0)

    # 通过工作流的 setup_func 获取参数，或使用通用默认值
    setup_func = wf.get("setup_func")
    if setup_func:
        params = setup_func(args)
    else:
        params = {
            "req_id": args.req_id,
            "title": args.title or f"需求 {args.req_id[:8]}",
            "project": args.project or "unknown",
            "repo_path": args.repo or "",
            "branch": f"feat/{args.req_id[:8]}",
            "agents": {},
            "notify_target": "",
            "channel": "log",
        }

    create_task(
        task_id=task_id,
        workflow=args.workflow,
        **params,
    )
    title = params.get("title", task_id)
    print(f"✓ 任务已注册：{task_id} — {title}")
    print(f"  工作流：{args.workflow}")

    # 获取工作流的第一个阶段
    first_phase = wf["phases"][0]["name"]
    print(f"  开始 {first_phase}...")

    execute_phase(task_id, first_phase)


if __name__ == "__main__":
    main()
