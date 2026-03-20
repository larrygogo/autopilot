"""数据库初始化和基础操作
Database initialization and basic operations."""

from __future__ import annotations

import json
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
    title TEXT NOT NULL,
    workflow TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_count INTEGER DEFAULT 0,
    channel TEXT DEFAULT 'log',
    notify_target TEXT,
    extra TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
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

# 列名常量：用于区分列字段 vs extra 字段 / Column name constants: distinguish column fields from extra fields
_TABLE_COLUMNS = frozenset(
    {
        "id",
        "title",
        "workflow",
        "status",
        "failure_count",
        "channel",
        "notify_target",
        "extra",
        "created_at",
        "updated_at",
        "started_at",
        "parent_task_id",
        "parallel_index",
        "parallel_group",
    }
)

_local = threading.local()


def get_conn() -> sqlite3.Connection:
    """获取 SQLite 连接（线程本地单例，WAL 模式）
    Get SQLite connection (thread-local singleton, WAL mode)."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        # 检查连接是否还有效 / Check if connection is still valid
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
    """关闭当前线程的连接（可选，进程退出时自动关闭）
    Close current thread's connection (optional, auto-closed on process exit)."""
    conn = getattr(_local, "conn", None)
    if conn:
        conn.close()
        _local.conn = None


def init_db() -> None:
    """初始化数据库
    Initialize the database."""
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


def _split_fields(fields: dict) -> tuple[dict, dict]:
    """将字段拆分为列字段和 extra 字段
    Split fields into column fields and extra fields."""
    col_fields = {}
    extra_fields = {}
    for k, v in fields.items():
        if k in _TABLE_COLUMNS:
            col_fields[k] = v
        else:
            extra_fields[k] = v
    return col_fields, extra_fields


def merge_extra_json(conn, task_id: str, extra_fields: dict) -> str:
    """原子合并 extra JSON 字段（调用方需确保在事务内）
    Atomically merge extra JSON fields (caller must ensure within transaction).

    读取当前 extra → 合并新字段 → 返回序列化后的 JSON 字符串。
    Read current extra → merge new fields → return serialized JSON string.

    Args:
        conn: 数据库连接（应在 BEGIN IMMEDIATE 事务内）
              Database connection (should be within BEGIN IMMEDIATE transaction)
        task_id: 任务 ID / Task ID
        extra_fields: 要合并的字段 / Fields to merge

    Returns:
        合并后的 JSON 字符串 / Merged JSON string
    """
    row = conn.execute("SELECT extra FROM tasks WHERE id = ?", (task_id,)).fetchone()
    try:
        current_extra = json.loads(row["extra"]) if row and row["extra"] else {}
    except (json.JSONDecodeError, TypeError):
        current_extra = {}
    current_extra.update(extra_fields)
    return json.dumps(current_extra, ensure_ascii=False)


def get_task(task_id: str) -> dict | None:
    """获取任务，自动将 extra JSON 合并到返回 dict
    Get task, automatically merge extra JSON into returned dict."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return None
        return _row_to_dict(row)


def get_active_tasks(include_sub_tasks: bool = True) -> list[dict]:
    """获取所有活跃任务（未到终态）
    Get all active tasks (not in terminal state).

    Args:
        include_sub_tasks: 是否包含子任务，默认 True / Whether to include sub-tasks, default True
    """
    # 收集所有工作流的终态 / Collect terminal states from all workflows
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
        return [_row_to_dict(r) for r in rows]


def _row_to_dict(row) -> dict:
    """将数据库行转为 dict，自动展开 extra JSON
    Convert database row to dict, automatically expand extra JSON."""
    result = dict(row)
    extra_raw = result.pop("extra", "{}")
    try:
        extra = json.loads(extra_raw) if extra_raw else {}
    except (json.JSONDecodeError, TypeError):
        extra = {}
    result.update(extra)
    return result


def create_task(
    task_id: str,
    title: str,
    workflow: str,
    *,
    channel: str = "log",
    notify_target: str = "",
    initial_status: str | None = None,
    **extra,
) -> None:
    """创建新任务
    Create a new task.

    核心字段通过显式参数传入，其余字段自动存入 extra JSON。
    Core fields are passed as explicit arguments; remaining fields are stored in extra JSON.

    Args:
        task_id: 任务 ID / Task ID
        title: 任务标题 / Task title
        workflow: 工作流名称 / Workflow name
        channel: 通知渠道，默认 'log' / Notification channel, default 'log'
        notify_target: 通知目标 / Notification target
        initial_status: 初始状态，默认从工作流定义的 initial_state 获取
                        Initial status, defaults to workflow's initial_state
        **extra: 工作流自定义字段（如 req_id, project, repo_path 等），存入 extra JSON
                 Workflow custom fields (e.g. req_id, project, repo_path), stored in extra JSON
    """
    # 确定初始状态 / Determine initial status
    if initial_status is None:
        from core import registry

        wf = registry.get_workflow(workflow)
        if not wf:
            raise ValueError(f"未知工作流：{workflow}，请先注册")
        initial_status = wf["initial_state"]

    extra_json = json.dumps(extra, ensure_ascii=False) if extra else "{}"

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO tasks
            (id, title, workflow, channel, notify_target, extra,
             status, created_at, updated_at, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                task_id,
                title,
                workflow,
                channel,
                notify_target,
                extra_json,
                initial_status,
                now(),
                now(),
                now(),
            ),
        )


def update_task(task_id: str, **fields) -> None:
    """透明更新任务字段 — 列字段直接 SET，其余合并入 extra JSON
    Transparently update task fields — column fields via SET, others merged into extra JSON.

    当存在 extra 字段更新时使用 BEGIN IMMEDIATE 保证原子性。
    Uses BEGIN IMMEDIATE for atomicity when extra fields are updated.

    Args:
        task_id: 任务 ID / Task ID
        **fields: 要更新的字段 / Fields to update
    """
    if not fields:
        return

    col_fields, extra_fields = _split_fields(fields)

    conn = get_conn()

    if extra_fields:
        # extra 字段需要 read-modify-write，必须用显式事务保证原子性
        # Extra fields need read-modify-write, require explicit transaction for atomicity
        original_isolation = conn.isolation_level
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                col_fields["extra"] = merge_extra_json(conn, task_id, extra_fields)
                if col_fields:
                    col_fields["updated_at"] = now()
                    set_clause = ", ".join(f"{k} = ?" for k in col_fields)
                    values = list(col_fields.values()) + [task_id]
                    conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", values)
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        finally:
            conn.isolation_level = original_isolation
    elif col_fields:
        col_fields["updated_at"] = now()
        set_clause = ", ".join(f"{k} = ?" for k in col_fields)
        values = list(col_fields.values()) + [task_id]
        with conn:
            conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", values)


def get_task_logs(task_id: str, limit: int = 20) -> list[dict]:
    """获取任务流转日志
    Get task transition logs."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM task_logs WHERE task_id = ?
            ORDER BY created_at DESC LIMIT ?
        """,
            (task_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def list_tasks(status: str | None = None, workflow: str | None = None, limit: int = 50) -> list[dict]:
    """带过滤条件的任务列表（参数化查询）
    Filtered task list (parameterized query)."""
    query = "SELECT * FROM tasks WHERE 1=1"
    params: list = []
    if status:
        query += " AND status = ?"
        params.append(status)
    if workflow:
        query += " AND workflow = ?"
        params.append(workflow)
    query += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [_row_to_dict(r) for r in rows]


def get_task_stats() -> dict:
    """聚合统计：总数、按状态/工作流分组、成功率、平均耗时
    Aggregate statistics: total, grouped by status/workflow, success rate, average duration.

    SQL 做 GROUP BY 基础聚合，Python 层根据 registry 的终态归类计算成功率。
    SQL performs GROUP BY aggregation; Python layer computes success rate based on registry terminal states.
    平均耗时仅统计已到达终态的任务。
    Average duration only counts tasks that reached terminal state.
    """
    with get_conn() as conn:
        # 总数 / Total count
        total = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]

        # 按状态分组 / Group by status
        by_status: dict[str, int] = {}
        for row in conn.execute("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status"):
            by_status[row["status"]] = row["cnt"]

        # 按工作流分组 / Group by workflow
        by_workflow: dict[str, int] = {}
        for row in conn.execute("SELECT workflow, COUNT(*) as cnt FROM tasks GROUP BY workflow"):
            by_workflow[row["workflow"]] = row["cnt"]

    # 成功率：收集各工作流的成功终态（非 cancelled）
    # Success rate: collect success terminal states (non-cancelled) from all workflows
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

    # 平均耗时（仅终态任务）/ Average duration (terminal tasks only)
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


# ──────────────────────────────────────────────
# 子任务（并行阶段支持）
# Sub-tasks (parallel phase support)
# ──────────────────────────────────────────────


def create_sub_task(
    parent_task_id: str,
    sub_task_id: str,
    phase_name: str,
    parallel_group: str,
    parallel_index: int,
    initial_status: str = "pending",
) -> None:
    """创建子任务（继承父任务的基本信息和 extra 字段）
    Create sub-task (inherits parent task's basic info and extra fields)."""
    parent = get_task(parent_task_id)
    if not parent:
        raise ValueError(f"父任务不存在：{parent_task_id}")

    # 从父任务中提取 extra 字段（排除列字段）/ Extract extra fields from parent (exclude column fields)
    parent_extra = {k: v for k, v in parent.items() if k not in _TABLE_COLUMNS}
    extra_json = json.dumps(parent_extra, ensure_ascii=False) if parent_extra else "{}"

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO tasks
            (id, title, workflow, channel, notify_target, extra,
             status, created_at, updated_at, started_at,
             parent_task_id, parallel_index, parallel_group)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                sub_task_id,
                f"{parent['title']} [{phase_name}]",
                parent["workflow"],
                parent.get("channel", "log"),
                parent.get("notify_target", ""),
                extra_json,
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
    """查询子任务列表
    Query sub-task list."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY parallel_index",
            (parent_task_id,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def all_sub_tasks_done(parent_task_id: str) -> bool:
    """检查是否所有子任务已完成（到达终态）
    Check if all sub-tasks are done (reached terminal state)."""
    terminal = {"cancelled"}
    try:
        from core import registry

        for wf_info in registry.list_workflows():
            wf = registry.get_workflow(wf_info["name"])
            if wf:
                terminal.update(wf.get("terminal_states", []))
    except Exception:
        pass

    # 子任务完成状态：包含 *_done 和其他终态 / Sub-task done states: includes *_done and other terminal states
    subs = get_sub_tasks(parent_task_id)
    if not subs:
        return True

    for sub in subs:
        status = sub["status"]
        if status not in terminal and not status.endswith("_done"):
            return False
    return True


def any_sub_task_failed(parent_task_id: str) -> bool:
    """检查是否有子任务失败（被取消视为失败）
    Check if any sub-task has failed (cancelled counts as failed)."""
    subs = get_sub_tasks(parent_task_id)
    for sub in subs:
        if sub["status"] == "cancelled":
            return True
    return False


if __name__ == "__main__":
    init_db()
