"""添加并行阶段支持：子任务模型
Add parallel phase support: sub-task model.

新增字段 / New fields:
  - parent_task_id: 父任务 ID（NULL 表示顶级任务）/ Parent task ID (NULL for top-level tasks)
  - parallel_index: 并行组内的索引 / Index within parallel group
  - parallel_group: 并行组名称 / Parallel group name
"""

from __future__ import annotations

import sqlite3


def up(conn: sqlite3.Connection) -> None:
    """为 tasks 表添加并行支持字段
    Add parallel support fields to tasks table."""
    # 检查 tasks 表是否存在 / Check if tasks table exists
    row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").fetchone()
    if not row:
        return

    # 检查列是否已存在（幂等）/ Check if columns already exist (idempotent)
    columns = {col[1] for col in conn.execute("PRAGMA table_info(tasks)").fetchall()}

    if "parent_task_id" not in columns:
        conn.execute("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT DEFAULT NULL")
    if "parallel_index" not in columns:
        conn.execute("ALTER TABLE tasks ADD COLUMN parallel_index INTEGER DEFAULT NULL")
    if "parallel_group" not in columns:
        conn.execute("ALTER TABLE tasks ADD COLUMN parallel_group TEXT DEFAULT NULL")

    conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_task_id)")
