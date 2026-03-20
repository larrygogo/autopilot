#!/usr/bin/env python3
"""
列出所有已注册工作流。
List all registered workflows.

用法 / Usage：
  python bin/list_workflows.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


def main():
    import core.workflows  # noqa: F401
    from core.registry import get_workflow, list_workflows

    workflows = list_workflows()
    if not workflows:
        print("暂无已注册工作流")
        return

    for wf_info in workflows:
        wf = get_workflow(wf_info["name"])
        if not wf:
            continue

        print(f"工作流: {wf['name']}")
        if wf.get("description"):
            print(f"  描述:     {wf['description']}")
        print(f"  初始状态: {wf['initial_state']}")
        print(f"  终态:     {', '.join(wf['terminal_states'])}")
        print(f"  阶段 ({len(wf['phases'])}):")
        for phase in wf["phases"]:
            if "parallel" in phase:
                p = phase["parallel"]
                print(f"    - [并行] {p['name']}:")
                for sub in p.get("phases", []):
                    sub_label = f" [{sub['label']}]" if sub.get("label") else ""
                    print(f"        - {sub['name']}{sub_label}: {sub['pending_state']} → {sub['running_state']}")
            else:
                label = f" [{phase['label']}]" if phase.get("label") else ""
                trigger_info = f"trigger={phase.get('trigger')}" if phase.get("trigger") else "(auto)"
                pending, running = phase["pending_state"], phase["running_state"]
                print(f"    - {phase['name']}{label}: {pending} → {running}  {trigger_info}")
        print()


if __name__ == "__main__":
    main()
