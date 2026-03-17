"""
数据库初始化和基础操作
"""
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
            with open(p) as f:
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
    status TEXT NOT NULL DEFAULT 'pending_design',
    rejection_count INTEGER DEFAULT 0,
    code_rejection_count INTEGER DEFAULT 0,
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

def get_conn():
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

def close_conn():
    """关闭当前线程的连接（可选，进程退出时自动关闭）"""
    conn = getattr(_local, 'conn', None)
    if conn:
        conn.close()
        _local.conn = None

def init_db():
    """初始化数据库"""
    with get_conn() as conn:
        conn.executescript(SCHEMA)
    print(f'✓ 数据库初始化完成：{DB_PATH}')

def now():
    return datetime.now(timezone.utc).isoformat()

def get_task(task_id):
    """获取任务"""
    with get_conn() as conn:
        row = conn.execute('SELECT * FROM tasks WHERE id = ?', (task_id,)).fetchone()
        return dict(row) if row else None

def get_active_tasks():
    """获取所有活跃任务（未到终态）"""
    terminal = ('pr_submitted', 'cancelled')
    placeholders = ','.join('?' * len(terminal))
    with get_conn() as conn:
        rows = conn.execute(
            f'SELECT * FROM tasks WHERE status NOT IN ({placeholders})', terminal
        ).fetchall()
        return [dict(r) for r in rows]

def create_task(task_id, req_id, title, project, repo_path, branch,
                agents, notify_target, channel='telegram'):
    """创建新任务"""
    import json
    with get_conn() as conn:
        conn.execute('''
            INSERT INTO tasks
            (id, req_id, title, project, repo_path, branch,
             agents, notify_target, channel, created_at, updated_at, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (task_id, req_id, title, project, repo_path, branch,
              json.dumps(agents), notify_target, channel,
              now(), now(), now()))

def get_task_logs(task_id, limit=20):
    """获取任务流转日志"""
    with get_conn() as conn:
        rows = conn.execute('''
            SELECT * FROM task_logs WHERE task_id = ?
            ORDER BY created_at DESC LIMIT ?
        ''', (task_id, limit)).fetchall()
        return [dict(r) for r in rows]

if __name__ == '__main__':
    init_db()
