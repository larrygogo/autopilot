"""
基线迁移：建立版本追踪起点。

现有表由 init_db() 的 CREATE TABLE IF NOT EXISTS 创建，
此迁移仅标记 schema 版本基线。
"""

from __future__ import annotations

import sqlite3


def up(conn: sqlite3.Connection) -> None:
    pass
