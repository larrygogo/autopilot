#!/usr/bin/env python3
"""
注册新开发任务并启动流程。
用法：
  python3 bin/start_task.py <req_id> [--project <project>] [--repo <repo_path>]
"""
import sys, argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / 'src'))

from dev_workflow.db import init_db, get_task, CONFIG
from dev_workflow.runner import execute_phase, DEFAULT_NOTIFY_CHANNEL, DEFAULT_NOTIFY_TARGET

def main():
    parser = argparse.ArgumentParser(description='注册并启动开发任务')
    parser.add_argument('req_id', help='ReqGenie 需求 ID')
    parser.add_argument('--project', help='项目名（对应 config.yaml 中的 projects 配置）')
    parser.add_argument('--repo', help='本地仓库路径（覆盖 config.yaml）')
    parser.add_argument('--title', help='需求标题（可选，会从 ReqGenie 自动拉取）')
    args = parser.parse_args()

    init_db()

    # 检查是否已注册
    task_id = f'{args.req_id[:8]}'
    existing = get_task(task_id)
    if existing:
        print(f'任务已存在：{task_id}，当前状态：{existing["status"]}')
        sys.exit(0)

    # 获取项目配置
    projects_cfg = CONFIG.get('projects', {})
    project_name = args.project or list(projects_cfg.keys())[0] if projects_cfg else 'unknown'
    project_cfg = projects_cfg.get(project_name, {})
    repo_path = args.repo or project_cfg.get('repo_path', '')
    if repo_path:
        repo_path = str(Path(repo_path).expanduser())

    # 默认 agents
    agents_cfg = CONFIG.get('agents', {}).get('default', {})
    agents = {
        'planDesign':  agents_cfg.get('plan_design', 'claude'),
        'planReview':  agents_cfg.get('plan_review', 'codex'),
        'development': agents_cfg.get('development', 'claude'),
        'codeReview':  agents_cfg.get('code_review', 'codex'),
    }

    # 拉取需求标题（如未提供）
    title = args.title or f'需求 {args.req_id[:8]}'
    try:
        from dev_workflow.runner import fetch_req
        req = fetch_req(args.req_id)
        if req:
            title = req.get('title', title)
    except Exception:
        pass

    from dev_workflow.db import create_task
    create_task(
        task_id=task_id,
        req_id=args.req_id,
        title=title,
        project=project_name,
        repo_path=repo_path,
        branch=f'feat/{project_name}-{task_id}',
        agents=agents,
        notify_target=DEFAULT_NOTIFY_TARGET,
        channel=DEFAULT_NOTIFY_CHANNEL,
    )
    print(f'✓ 任务已注册：{task_id} — {title}')
    print(f'  项目：{project_name}，仓库：{repo_path}')
    print(f'  开始方案设计...')

    execute_phase(task_id, 'design')

if __name__ == '__main__':
    main()
