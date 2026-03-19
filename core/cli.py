"""
dev-pilot 统一 CLI 入口（click）
"""

from __future__ import annotations

import sys

import click

from core import __version__


@click.group()
@click.version_option(version=__version__, prog_name="dev-pilot")
def main():
    """dev-pilot: AI 驱动的工作流自动化框架"""
    pass


def _ensure_workflows():
    """确保工作流已注册"""
    import core.workflows  # noqa: F401


# ──────────────────────────────────────────────────────────
# start
# ──────────────────────────────────────────────────────────


@main.command()
@click.argument("req_id")
@click.option("--project", default=None, help="项目名（对应 config.yaml 中的 projects 配置）")
@click.option("--repo", default=None, help="本地仓库路径（覆盖 config.yaml）")
@click.option("--title", default=None, help="需求标题（可选）")
@click.option("--workflow", default=None, help="工作流名称")
def start(req_id, project, repo, title, workflow):
    """注册并启动任务"""
    from core.db import create_task, get_task, init_db

    init_db()
    _ensure_workflows()

    from core.registry import get_workflow, list_workflows

    available = list_workflows()

    if workflow is None:
        if not available:
            click.echo("没有已注册的工作流，请先将工作流放入 DEV_PILOT_HOME/workflows/ 目录")
            sys.exit(1)
        elif len(available) == 1:
            workflow = available[0]["name"]
            click.echo(f"自动选择唯一工作流：{workflow}")
        else:
            names = [w["name"] for w in available]
            click.echo(f"有多个工作流可用：{names}，请通过 --workflow 指定")
            sys.exit(1)

    wf = get_workflow(workflow)
    if not wf:
        names = [w["name"] for w in available]
        click.echo(f"未知工作流：{workflow}，可用工作流：{names}")
        sys.exit(1)

    task_id = f"{req_id[:8]}"
    existing = get_task(task_id)
    if existing:
        click.echo(f"任务已存在：{task_id}，当前状态：{existing['status']}")
        sys.exit(0)

    setup_func = wf.get("setup_func")
    if setup_func:
        # 构建类似 argparse 的命名空间
        from types import SimpleNamespace

        args = SimpleNamespace(req_id=req_id, project=project, repo=repo, title=title, workflow=workflow)
        params = setup_func(args)
    else:
        params = {
            "req_id": req_id,
            "title": title or f"需求 {req_id[:8]}",
            "project": project or "unknown",
            "repo_path": repo or "",
            "branch": f"feat/{req_id[:8]}",
            "agents": {},
            "notify_target": "",
            "channel": "log",
        }

    create_task(task_id=task_id, workflow=workflow, **params)
    click.echo(f"✓ 任务已注册：{task_id} — {params.get('title', task_id)}")
    click.echo(f"  工作流：{workflow}")

    first_phase = wf["phases"][0]["name"]
    click.echo(f"  开始 {first_phase}...")

    from core.runner import execute_phase

    execute_phase(task_id, first_phase)


# ──────────────────────────────────────────────────────────
# cancel
# ──────────────────────────────────────────────────────────


@main.command()
@click.argument("task_id")
@click.option("--reason", default="用户手动取消", help="取消原因")
def cancel(task_id, reason):
    """取消任务"""
    _ensure_workflows()

    from core.db import get_task
    from core.infra import notify
    from core.registry import get_terminal_states
    from core.state_machine import InvalidTransitionError, transition

    task = get_task(task_id)
    if not task:
        click.echo(f"任务不存在：{task_id}")
        sys.exit(1)

    terminal_states = set(get_terminal_states(task.get("workflow", "")))
    terminal_states.add("cancelled")

    if task["status"] in terminal_states:
        click.echo(f"任务已处于终态：{task['status']}")
        sys.exit(0)

    try:
        transition(task_id, "cancel", note=reason)
        click.echo(f"✓ 任务已取消：{task_id} — {task['title']}")
        notify(task, f"🚫 任务已取消：《{task['title']}》\n\n原因：{reason}", event="info")
    except InvalidTransitionError as e:
        click.echo(f"取消失败：{e}")
        sys.exit(1)


# ──────────────────────────────────────────────────────────
# list
# ──────────────────────────────────────────────────────────


@main.command("list")
@click.option("--status", default=None, help="按状态过滤")
@click.option("--workflow", default=None, help="按工作流过滤")
@click.option("--project", default=None, help="按项目过滤")
@click.option("--limit", default=50, type=int, help="最大返回条数（默认 50）")
def list_cmd(status, workflow, project, limit):
    """查询任务列表"""
    from core.db import init_db, list_tasks

    init_db()
    _ensure_workflows()

    tasks = list_tasks(status=status, workflow=workflow, project=project, limit=limit)

    if not tasks:
        click.echo("暂无任务")
        return

    header = f"{'ID':<12} {'工作流':<14} {'状态':<20} {'标题':<30} {'更新时间':<26}"
    click.echo(header)
    click.echo("-" * len(header))
    for t in tasks:
        title = t["title"][:28] + ".." if len(t["title"]) > 30 else t["title"]
        click.echo(f"{t['id']:<12} {t['workflow']:<14} {t['status']:<20} {title:<30} {t['updated_at']:<26}")

    click.echo(f"\n共 {len(tasks)} 条")


# ──────────────────────────────────────────────────────────
# show
# ──────────────────────────────────────────────────────────


@main.command()
@click.argument("task_id")
@click.option("--logs", "log_count", default=10, type=int, help="显示最近日志条数（默认 10）")
def show(task_id, log_count):
    """查看任务详情"""
    from core.db import get_task, get_task_logs, init_db

    init_db()
    _ensure_workflows()

    task = get_task(task_id)
    if not task:
        click.echo(f"任务不存在：{task_id}")
        sys.exit(1)

    click.echo(f"任务 ID:    {task['id']}")
    click.echo(f"标题:       {task['title']}")
    click.echo(f"工作流:     {task['workflow']}")
    click.echo(f"项目:       {task['project']}")
    click.echo(f"状态:       {task['status']}")
    click.echo(f"分支:       {task['branch']}")
    if task.get("pr_url"):
        click.echo(f"PR:         {task['pr_url']}")
    click.echo(f"创建时间:   {task['created_at']}")
    click.echo(f"更新时间:   {task['updated_at']}")

    failure_count = task.get("failure_count", 0)
    rejection_count = task.get("rejection_count", 0)
    if failure_count or rejection_count:
        click.echo(f"\n失败次数:   {failure_count}")
        click.echo(f"驳回次数:   {rejection_count}")

    from core.infra import is_locked

    locked = is_locked(task_id)
    click.echo(f"\n锁状态:     {'已锁定（有进程运行中）' if locked else '未锁定'}")

    from core.state_machine import get_available_triggers

    triggers = get_available_triggers(task_id)
    if triggers:
        click.echo(f"可用操作:   {', '.join(triggers)}")
    else:
        click.echo("可用操作:   无（终态或无转换）")

    logs = get_task_logs(task_id, limit=log_count)
    if logs:
        click.echo(f"\n最近 {len(logs)} 条状态变更日志:")
        click.echo(f"  {'时间':<26} {'从':<20} {'到':<20} {'触发器':<16} {'备注'}")
        for log_entry in logs:
            from_s = log_entry.get("from_status") or "-"
            to_s = log_entry["to_status"]
            trigger = log_entry.get("trigger") or "-"
            note = log_entry.get("note") or ""
            click.echo(f"  {log_entry['created_at']:<26} {from_s:<20} {to_s:<20} {trigger:<16} {note}")


# ──────────────────────────────────────────────────────────
# workflows
# ──────────────────────────────────────────────────────────


@main.command()
def workflows():
    """列出所有已注册工作流"""
    _ensure_workflows()

    from core.registry import get_workflow, list_workflows

    wf_list = list_workflows()
    if not wf_list:
        click.echo("暂无已注册工作流")
        return

    for wf_info in wf_list:
        wf = get_workflow(wf_info["name"])
        if not wf:
            continue

        click.echo(f"工作流: {wf['name']}")
        if wf.get("description"):
            click.echo(f"  描述:     {wf['description']}")
        click.echo(f"  初始状态: {wf['initial_state']}")
        click.echo(f"  终态:     {', '.join(wf['terminal_states'])}")
        click.echo(f"  阶段 ({len(wf['phases'])}):")
        for phase in wf["phases"]:
            label = f" [{phase['label']}]" if phase.get("label") else ""
            trigger_info = f"trigger={phase.get('trigger')}" if phase.get("trigger") else "(auto)"
            line = f"    - {phase['name']}{label}: {phase['pending_state']} → {phase['running_state']}  {trigger_info}"
            click.echo(line)
        click.echo()


# ──────────────────────────────────────────────────────────
# stats
# ──────────────────────────────────────────────────────────


@main.command()
def stats():
    """任务统计概览"""
    from core.db import get_task_stats, init_db

    init_db()
    _ensure_workflows()

    s = get_task_stats()

    click.echo(f"任务总数:     {s['total']}")
    click.echo(f"成功率:       {s['success_rate']}%")

    avg_dur = s["avg_duration_seconds"]
    if avg_dur > 3600:
        click.echo(f"平均耗时:     {avg_dur / 3600:.1f} 小时")
    elif avg_dur > 60:
        click.echo(f"平均耗时:     {avg_dur / 60:.1f} 分钟")
    else:
        click.echo(f"平均耗时:     {avg_dur:.0f} 秒")

    if s["by_status"]:
        click.echo("\n按状态分布:")
        for status_name, count in sorted(s["by_status"].items()):
            click.echo(f"  {status_name:<24} {count}")

    if s["by_workflow"]:
        click.echo("\n按工作流分布:")
        for wf_name, count in sorted(s["by_workflow"].items()):
            click.echo(f"  {wf_name:<24} {count}")


# ──────────────────────────────────────────────────────────
# init
# ──────────────────────────────────────────────────────────


@main.command()
@click.option("--path", default=None, help="自定义工作空间路径（默认 ~/.dev-pilot/）")
def init(path):
    """初始化用户工作空间"""
    import shutil
    from pathlib import Path

    from core import DEV_PILOT_HOME

    framework_root = Path(__file__).parent.parent

    if path:
        home = Path(path).expanduser()
    else:
        home = DEV_PILOT_HOME

    click.echo(f"初始化用户工作空间：{home}")

    dirs = [home / "workflows", home / "prompts", home / "runtime"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
        click.echo(f"  ✓ {d}")

    config_dest = home / "config.yaml"
    config_src = framework_root / "config.example.yaml"
    if not config_dest.exists() and config_src.exists():
        shutil.copy2(config_src, config_dest)
        click.echo(f"  ✓ {config_dest}（从模板复制）")
    elif config_dest.exists():
        click.echo(f"  - {config_dest}（已存在，跳过）")

    examples_dir = framework_root / "examples"
    if examples_dir.is_dir():
        for wf_dir in sorted(examples_dir.iterdir()):
            if not wf_dir.is_dir():
                continue
            wf_file = wf_dir / "workflow.py"
            if not wf_file.exists():
                continue
            dest = home / "workflows" / f"{wf_dir.name}.py"
            if not dest.exists():
                shutil.copy2(wf_file, dest)
                click.echo(f"  ✓ {dest}（示例工作流）")
            else:
                click.echo(f"  - {dest}（已存在，跳过）")

            prompts_dir = wf_dir / "prompts"
            if prompts_dir.is_dir():
                dest_prompts = home / "prompts" / wf_dir.name
                dest_prompts.mkdir(parents=True, exist_ok=True)
                for prompt_file in sorted(prompts_dir.iterdir()):
                    prompt_dest = dest_prompts / prompt_file.name
                    if not prompt_dest.exists():
                        shutil.copy2(prompt_file, prompt_dest)
                        click.echo(f"  ✓ {prompt_dest}")

    click.echo("\n初始化完成！")
    click.echo("\n后续步骤：")
    click.echo(f"  1. 编辑 {config_dest} 配置框架参数")
    click.echo("  2. 运行 dev-pilot upgrade 初始化数据库")
    if path:
        click.echo(f"  3. 设置环境变量：export DEV_PILOT_HOME={home}")


# ──────────────────────────────────────────────────────────
# upgrade
# ──────────────────────────────────────────────────────────


@main.command()
@click.option("--status", "show_status", is_flag=True, help="查看当前版本")
@click.option("--dry-run", is_flag=True, help="预览待执行迁移")
def upgrade(show_status, dry_run):
    """数据库升级"""
    from core import DEV_PILOT_HOME
    from core.db import get_conn, init_db
    from core.migrate import (
        ensure_schema_version_table,
        get_current_version,
        get_pending_migrations,
        run_pending_migrations,
    )

    click.echo(f"dev-pilot v{__version__}")
    click.echo(f"DEV_PILOT_HOME: {DEV_PILOT_HOME}")
    click.echo()

    init_db()
    conn = get_conn()
    ensure_schema_version_table(conn)

    current = get_current_version(conn)
    pending = get_pending_migrations(conn)

    if show_status:
        click.echo(f"当前 schema 版本：{current}")
        click.echo(f"待执行迁移数：{len(pending)}")
        if pending:
            for v, name, _ in pending:
                click.echo(f"  - {v:03d}_{name}")
        else:
            click.echo("已是最新版本。")
        return

    if dry_run:
        if not pending:
            click.echo("没有待执行的迁移。")
            return
        click.echo(f"将执行以下 {len(pending)} 个迁移：")
        for v, name, _ in pending:
            click.echo(f"  - {v:03d}_{name}")
        return

    if not pending:
        click.echo("数据库已是最新版本。")
        return

    click.echo(f"当前版本：{current}，待执行 {len(pending)} 个迁移...")
    try:
        executed = run_pending_migrations(conn)
        new_version = get_current_version(conn)
        click.echo(f"✓ 升级完成：{current} → {new_version}（执行了 {executed} 个迁移）")
    except Exception as e:
        click.echo(f"✗ 升级失败：{e}", err=True)
        sys.exit(1)


# ──────────────────────────────────────────────────────────
# config
# ──────────────────────────────────────────────────────────


@main.group()
def config():
    """配置管理"""
    pass


@config.command("check")
@click.option("--file", "config_file", default=None, type=click.Path(exists=True), help="指定配置文件路径")
def config_check(config_file):
    """校验配置文件"""
    from core.config import load_config, validate_config

    if config_file:
        import yaml

        with open(config_file, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    else:
        cfg = load_config()

    if not cfg:
        click.echo("未找到配置文件或配置为空")
        return

    errors, warnings = validate_config(cfg)

    if not errors and not warnings:
        click.echo("✓ 配置校验通过")
        return

    for w in warnings:
        click.echo(f"⚠ {w}")
    for e in errors:
        click.echo(f"✗ {e}")

    if errors:
        sys.exit(1)


# ──────────────────────────────────────────────────────────
# watch
# ──────────────────────────────────────────────────────────


@main.command()
def watch():
    """卡死检测与自动恢复"""
    _ensure_workflows()

    from core.watcher import main as watcher_main

    watcher_main()
