"""基线迁移：建立版本追踪起点。
Baseline migration: establish version tracking starting point.

现有表由 init_db() 的 CREATE TABLE IF NOT EXISTS 创建，
此迁移仅标记 schema 版本基线。
Existing tables are created by init_db()'s CREATE TABLE IF NOT EXISTS;
this migration only marks the schema version baseline."""

from __future__ import annotations

import sqlite3


def up(conn: sqlite3.Connection) -> None:
    """基线迁移无需操作
    Baseline migration requires no action."""
    pass
