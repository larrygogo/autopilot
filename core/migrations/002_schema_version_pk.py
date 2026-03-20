"""为 schema_version 表添加 PRIMARY KEY 约束。
Add PRIMARY KEY constraint to schema_version table.

SQLite 不支持 ALTER TABLE ADD PRIMARY KEY，需要重建表。
SQLite does not support ALTER TABLE ADD PRIMARY KEY; table rebuild is required."""

from __future__ import annotations

import sqlite3


def up(conn: sqlite3.Connection) -> None:
    """重建 schema_version 表以添加主键约束
    Rebuild schema_version table to add primary key constraint."""
    # 检查表是否存在 / Check if table exists
    row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone()
    if not row:
        return

    conn.execute("""
        CREATE TABLE schema_version_new (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        INSERT OR IGNORE INTO schema_version_new (version, name, applied_at)
        SELECT version, name, applied_at FROM schema_version
    """)
    conn.execute("DROP TABLE schema_version")
    conn.execute("ALTER TABLE schema_version_new RENAME TO schema_version")
