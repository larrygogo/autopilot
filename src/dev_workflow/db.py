"""
数据库初始化和基础操作
"""
from __future__ import annotations

import sqlite3, os
from pathlib import Path
from datetime import datetime, timezone


def _load_config():
    """加载配置文件，按优先级查找"""
    try:
        import yaml
    except ImportError:
        return {}
    env_cfg = os.environ.get('DEV_WORKFLOW_CONFIG', '')
    search_paths = [
        Path(env_cfg) if env_cfg else None,
        Path.cwd() / 'config.yaml',
        Path.home() / '.openclaw/dev-workflow/config.yaml',
        Path(__file__).parent.parent.parent / 'config.yaml',
    ]
    for p in search_paths:
        if p and p.is_file():
            with open(p, encoding='utf-8') as f:
                return yaml.safe_load(f) or {}
    return {}

CONFIG = _load_config()

WORKSPACE = Path(
    os.environ.get('OPENCLAW_WORKSPACE') or
    CONFIG.get('workspace') or
    Path.home() / '.openclaw/workspace'
).expanduser()
DB_PATH = WORKSPACE / 'runtime/workflow.db'

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    title TEXT NOT NULL,
    project TEXT,
    repo_path TEXT,
    branch TEXT,
    workflow TEXT NOT NULL DEFAULT 'dev',
    status TEXT NOT NULL DEFAULT 'pending_design',
    rejection_count INTEGER DEFAULT 0,
    code_rejection_count INTEGER DEFAULT 0,
    rejection_counts TEXT DEFAULT '{}',  -- JSON: {"design": 0, "code": 0, ...}
    failure_count INTEGER DEFAULT 0,
    rejection_reason TEXT,
    pr_url TEXT,
    agents TEXT,              -- JSON: {planDesign, planReview, development, codeReview}
    channel TEXT DEFAULT 'telegram',
    notify_target TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT           -- 当前阶段开始时间，用于卡死检测
);

CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    trigger TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
"""

import threading
_local = threading.local()

def get_conn() -> sqlite3.Connection:
    """获取 SQLite 连接（线程本地单例，WAL 模式）"""
    conn = getattr(_local, 'conn', None)
    if conn is not None:
        # 检查连接是否还有效
        try:
            conn.execute('SELECT 1')
            return conn
        except sqlite3.ProgrammingError:
            _local.conn = None

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    _local.conn = conn
    return conn

def close_conn() -> None:
    """关闭当前线程的连接（可选，进程退出时自动关闭）"""
    conn = getattr(_local, 'conn', None)
    if conn:
        conn.close()
        _local.conn = None

def init_db() -> None:
    """初始化数据库"""
    with get_conn() as conn:
        conn.executescript(SCHEMA)
    print(f'✓ 数据库初始化完成：{DB_PATH}')

def now() -> str:
    return datetime.now(timezone.utc).isoformat()

def get_task(task_id: str) -> dict | None:
    """获取任务"""
    with get_conn() as conn:
        row = conn.execute('SELECT * FROM tasks WHERE id = ?', (task_id,)).fetchone()
        return dict(row) if row else None

def get_active_tasks() -> list[dict]:
    """获取所有活跃任务（未到终态）"""
    # 收集所有工作流的终态
    terminal = {'pr_submitted', 'cancelled'}
    try:
        from dev_workflow import registry
        for wf_info in registry.list_workflows():
            wf = registry.get_workflow(wf_info['name'])
            if wf:
                terminal.update(wf.get('terminal_states', []))
    except Exception:
        pass
    terminal = tuple(terminal)
    placeholders = ','.join('?' * len(terminal))
    with get_conn() as conn:
        rows = conn.execute(
            f'SELECT * FROM tasks WHERE status NOT IN ({placeholders})', terminal
        ).fetchall()
        return [dict(r) for r in rows]

def create_task(task_id: str, req_id: str, title: str, project: str, repo_path: str, branch: str,
                agents: dict, notify_target: str, channel: str = 'telegram',
                workflow: str = 'dev', initial_status: str | None = None) -> None:
    """创建新任务

    Args:
        workflow: 工作流名称，默认 'dev'
        initial_status: 初始状态，默认从工作流定义的 initial_state 获取
    """
    import json
    # 确定初始状态
    if initial_status is None:
        try:
            from dev_workflow import registry
            wf = registry.get_workflow(workflow)
            initial_status = wf['initial_state'] if wf else 'pending_design'
        except Exception:
            initial_status = 'pending_design'

    with get_conn() as conn:
        conn.execute('''
            INSERT INTO tasks
            (id, req_id, title, project, repo_path, branch, workflow,
             agents, notify_target, channel, status, created_at, updated_at, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (task_id, req_id, title, project, repo_path, branch, workflow,
              json.dumps(agents), notify_target, channel, initial_status,
              now(), now(), now()))

def get_task_logs(task_id: str, limit: int = 20) -> list[dict]:
    """获取任务流转日志"""
    with get_conn() as conn:
        rows = conn.execute('''
            SELECT * FROM task_logs WHERE task_id = ?
            ORDER BY created_at DESC LIMIT ?
        ''', (task_id, limit)).fetchall()
        return [dict(r) for r in rows]

def get_default_branch(project: str | None = None) -> str:
    """获取主分支名称（项目级 > 全局 > 默认 main）"""
    if project:
        project_cfg = CONFIG.get('projects', {}).get(project, {})
        branch = project_cfg.get('default_branch')
        if branch:
            return branch
    return CONFIG.get('default_branch', 'main')


if __name__ == '__main__':
    init_db()
