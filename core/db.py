"""
数据库初始化和基础操作
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone

from core import AUTOPILOT_HOME
from core.config import load_config
from core.logger import get_logger

log = get_logger()


CONFIG = load_config()

DB_PATH = AUTOPILOT_HOME / "runtime/workflow.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    title TEXT NOT NULL,
    project TEXT,
    repo_path TEXT,
    branch TEXT,
    workflow TEXT NOT NULL,
    status TEXT NOT NULL,
    rejection_count INTEGER DEFAULT 0,
    code_rejection_count INTEGER DEFAULT 0,
    rejection_counts TEXT DEFAULT '{}',  -- JSON: {"design": 0, "code": 0, ...}
    failure_count INTEGER DEFAULT 0,
    rejection_reason TEXT,
    pr_url TEXT,
    agents TEXT,              -- JSON: workflow-defined agent roles
    channel TEXT DEFAULT 'log',
    notify_target TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,          -- 当前阶段开始时间，用于卡死检测
    parent_task_id TEXT DEFAULT NULL,
    parallel_index INTEGER DEFAULT NULL,
    parallel_group TEXT DEFAULT NULL
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
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_task_id);
"""

_local = threading.local()


def get_conn() -> sqlite3.Connection:
    """获取 SQLite 连接（线程本地单例，WAL 模式）"""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        # 检查连接是否还有效
        try:
            conn.execute("SELECT 1")
            return conn
        except sqlite3.ProgrammingError:
            _local.conn = None

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _local.conn = conn
    return conn


def close_conn() -> None:
    """关闭当前线程的连接（可选，进程退出时自动关闭）"""
    conn = getattr(_local, "conn", None)
    if conn:
        conn.close()
        _local.conn = None


def init_db() -> None:
    """初始化数据库"""
    with get_conn() as conn:
        conn.executescript(SCHEMA)
    log.info("数据库初始化完成：%s", DB_PATH)
    try:
        from core.migrate import check_schema

        if not check_schema(get_conn()):
            log.warning("数据库版本落后，请运行 autopilot upgrade")
    except Exception as e:
        log.warning("schema 版本检查失败：%s", e)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_task(task_id: str) -> dict | None:
    """获取任务"""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return dict(row) if row else None


def get_active_tasks(include_sub_tasks: bool = True) -> list[dict]:
    """获取所有活跃任务（未到终态）

    Args:
        include_sub_tasks: 是否包含子任务，默认 True
    """
    # 收集所有工作流的终态
    terminal = {"cancelled"}
    try:
        from core import registry

        for wf_info in registry.list_workflows():
            wf = registry.get_workflow(wf_info["name"])
            if wf:
                terminal.update(wf.get("terminal_states", []))
    except Exception as e:
        log.debug("获取工作流终态失败：%s", e)
    terminal_tuple = tuple(terminal)
    placeholders = ",".join("?" * len(terminal_tuple))
    query = f"SELECT * FROM tasks WHERE status NOT IN ({placeholders})"
    params: list = list(terminal_tuple)
    if not include_sub_tasks:
        query += " AND parent_task_id IS NULL"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


def create_task(
    task_id: str,
    req_id: str,
    title: str,
    project: str,
    repo_path: str,
    branch: str,
    agents: dict,
    notify_target: str,
    workflow: str,
    channel: str = "log",
    initial_status: str | None = None,
) -> None:
    """创建新任务

    Args:
        workflow: 工作流名称，默认 'dev'
        initial_status: 初始状态，默认从工作流定义的 initial_state 获取
    """
    import json

    # 确定初始状态
    if initial_status is None:
        from core import registry

        wf = registry.get_workflow(workflow)
        if not wf:
            raise ValueError(f"未知工作流：{workflow}，请先注册")
        initial_status = wf["initial_state"]

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO tasks
            (id, req_id, title, project, repo_path, branch, workflow,
             agents, notify_target, channel, status, created_at, updated_at, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                task_id,
                req_id,
                title,
                project,
                repo_path,
                branch,
                workflow,
                json.dumps(agents),
                notify_target,
                channel,
                initial_status,
                now(),
                now(),
                now(),
            ),
        )


def get_task_logs(task_id: str, limit: int = 20) -> list[dict]:
    """获取任务流转日志"""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM task_logs WHERE task_id = ?
            ORDER BY created_at DESC LIMIT ?
        """,
            (task_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def list_tasks(
    status: str | None = None, workflow: str | None = None, project: str | None = None, limit: int = 50
) -> list[dict]:
    """带过滤条件的任务列表（参数化查询）"""
    query = "SELECT * FROM tasks WHERE 1=1"
    params: list = []
    if status:
        query += " AND status = ?"
        params.append(status)
    if workflow:
        query += " AND workflow = ?"
        params.append(workflow)
    if project:
        query += " AND project = ?"
        params.append(project)
    query += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


def get_task_stats() -> dict:
    """聚合统计：总数、按状态/工作流分组、成功率、平均耗时

    SQL 做 GROUP BY 基础聚合，Python 层根据 registry 的终态归类计算成功率。
    平均耗时仅统计已到达终态的任务。
    """
    with get_conn() as conn:
        # 总数
        total = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]

        # 按状态分组
        by_status: dict[str, int] = {}
        for row in conn.execute("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status"):
            by_status[row["status"]] = row["cnt"]

        # 按工作流分组
        by_workflow: dict[str, int] = {}
        for row in conn.execute("SELECT workflow, COUNT(*) as cnt FROM tasks GROUP BY workflow"):
            by_workflow[row["workflow"]] = row["cnt"]

    # 成功率：收集各工作流的成功终态（非 cancelled）
    success_states: set[str] = set()
    try:
        from core import registry

        for wf_info in registry.list_workflows():
            wf = registry.get_workflow(wf_info["name"])
            if wf:
                for s in wf.get("terminal_states", []):
                    if s != "cancelled":
                        success_states.add(s)
    except Exception as e:
        log.debug("获取工作流终态失败：%s", e)

    success_count = sum(cnt for st, cnt in by_status.items() if st in success_states)
    terminal_count = success_count + by_status.get("cancelled", 0)
    success_rate = (success_count / terminal_count * 100) if terminal_count > 0 else 0.0

    # 平均耗时（仅终态任务）
    all_terminal = success_states | {"cancelled"}
    if all_terminal:
        placeholders = ",".join("?" * len(all_terminal))
        with get_conn() as conn:
            row = conn.execute(
                f"SELECT AVG((julianday(updated_at) - julianday(created_at)) * 86400) as avg_dur "
                f"FROM tasks WHERE status IN ({placeholders})",
                tuple(all_terminal),
            ).fetchone()
            avg_duration = row["avg_dur"] if row["avg_dur"] is not None else 0.0
    else:
        avg_duration = 0.0

    return {
        "total": total,
        "by_status": by_status,
        "by_workflow": by_workflow,
        "success_rate": round(success_rate, 2),
        "avg_duration_seconds": round(avg_duration, 2),
    }


# ──────────────────────────────────────────────────────────
# 子任务（并行阶段支持）
# ──────────────────────────────────────────────────────────


def create_sub_task(
    parent_task_id: str,
    sub_task_id: str,
    phase_name: str,
    parallel_group: str,
    parallel_index: int,
    initial_status: str = "pending",
) -> None:
    """创建子任务（继承父任务的基本信息）"""
    parent = get_task(parent_task_id)
    if not parent:
        raise ValueError(f"父任务不存在：{parent_task_id}")

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO tasks
            (id, req_id, title, project, repo_path, branch, workflow,
             agents, notify_target, channel, status, created_at, updated_at, started_at,
             parent_task_id, parallel_index, parallel_group)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                sub_task_id,
                parent["req_id"],
                f"{parent['title']} [{phase_name}]",
                parent["project"],
                parent["repo_path"],
                parent["branch"],
                parent["workflow"],
                parent["agents"],
                parent["notify_target"],
                parent["channel"],
                initial_status,
                now(),
                now(),
                now(),
                parent_task_id,
                parallel_index,
                parallel_group,
            ),
        )


def get_sub_tasks(parent_task_id: str) -> list[dict]:
    """查询子任务列表"""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY parallel_index",
            (parent_task_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def all_sub_tasks_done(parent_task_id: str) -> bool:
    """检查是否所有子任务已完成（到达终态）"""
    terminal = {"cancelled"}
    try:
        from core import registry

        for wf_info in registry.list_workflows():
            wf = registry.get_workflow(wf_info["name"])
            if wf:
                terminal.update(wf.get("terminal_states", []))
    except Exception:
        pass

    # 子任务完成状态：包含 *_done 和其他终态
    subs = get_sub_tasks(parent_task_id)
    if not subs:
        return True

    for sub in subs:
        status = sub["status"]
        if status not in terminal and not status.endswith("_done"):
            return False
    return True


def any_sub_task_failed(parent_task_id: str) -> bool:
    """检查是否有子任务失败（被取消视为失败）"""
    subs = get_sub_tasks(parent_task_id)
    for sub in subs:
        if sub["status"] == "cancelled":
            return True
    return False


if __name__ == "__main__":
    init_db()
