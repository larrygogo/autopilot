#!/usr/bin/env python3
"""
列出所有已注册工作流。
用法：
  python bin/list_workflows.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


def main():
    import core.workflows  # noqa: F401
    from core.registry import list_workflows, get_workflow

    workflows = list_workflows()
    if not workflows:
        print('暂无已注册工作流')
        return

    for wf_info in workflows:
        wf = get_workflow(wf_info['name'])
        if not wf:
            continue

        print(f'工作流: {wf["name"]}')
        if wf.get('description'):
            print(f'  描述:     {wf["description"]}')
        print(f'  初始状态: {wf["initial_state"]}')
        print(f'  终态:     {", ".join(wf["terminal_states"])}')
        print(f'  阶段 ({len(wf["phases"])}):')
        for phase in wf['phases']:
            label = f' [{phase["label"]}]' if phase.get('label') else ''
            trigger_info = f'trigger={phase.get("trigger")}' if phase.get('trigger') else '(auto)'
            print(f'    - {phase["name"]}{label}: {phase["pending_state"]} → {phase["running_state"]}  {trigger_info}')
        print()


if __name__ == '__main__':
    main()
