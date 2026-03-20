"""轻量数据库迁移引擎
Lightweight database migration engine.

迁移文件位于 core/migrations/，命名规则 NNN_description.py，
每个文件必须导出 up(conn) 函数。
Migration files are in core/migrations/, named NNN_description.py,
each file must export an up(conn) function."""

from __future__ import annotations

import importlib.util
import re
import sqlite3
from pathlib import Path
from typing import Callable

from core.logger import get_logger

log = get_logger()

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
_MIGRATION_PATTERN = re.compile(r"^(\d{3})_(\w+)\.py$")


def ensure_schema_version_table(conn: sqlite3.Connection) -> None:
    """幂等创建 schema_version 表
    Idempotently create schema_version table."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)


def get_current_version(conn: sqlite3.Connection) -> int:
    """获取当前 schema 版本号，0 表示未初始化
    Get current schema version; 0 means uninitialized."""
    ensure_schema_version_table(conn)
    row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    return row[0] or 0


def discover_migrations() -> list[tuple[int, str, Callable]]:
    """扫描 core/migrations/ 目录，返回排序后的 (version, name, up_func) 列表
    Scan core/migrations/ directory, return sorted list of (version, name, up_func)."""
    if not MIGRATIONS_DIR.is_dir():
        return []
    migrations: list[tuple[int, str, Callable]] = []
    for py_file in sorted(MIGRATIONS_DIR.iterdir()):
        match = _MIGRATION_PATTERN.match(py_file.name)
        if not match:
            continue
        version = int(match.group(1))
        # 只保留描述部分，避免日志拼接重复前缀
        # Keep description only to avoid prefix duplication in logs
        name = match.group(2)
        try:
            spec = importlib.util.spec_from_file_location(f"core.migrations.{py_file.stem}", py_file)
            if spec is None or spec.loader is None:
                raise RuntimeError(f"无法加载迁移模块 spec：{py_file.name}")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if not hasattr(mod, "up") or not callable(mod.up):
                raise RuntimeError(f"迁移 {py_file.name} 缺少 up() 函数")
            migrations.append((version, name, mod.up))
        except Exception as e:
            log.error("加载迁移 %s 失败：%s", py_file.name, e)
            raise
    return migrations


def get_pending_migrations(
    conn: sqlite3.Connection,
) -> list[tuple[int, str, Callable]]:
    """返回尚未执行的迁移列表
    Return list of migrations not yet applied."""
    current = get_current_version(conn)
    return [(v, n, fn) for v, n, fn in discover_migrations() if v > current]


def run_pending_migrations(conn: sqlite3.Connection) -> int:
    """执行所有待执行迁移，返回执行数量。失败时回滚当前迁移并抛出异常。
    Run all pending migrations, return count. On failure, rollback current migration and raise."""
    ensure_schema_version_table(conn)
    pending = get_pending_migrations(conn)
    if not pending:
        return 0
    executed = 0
    original_isolation = conn.isolation_level
    try:
        # 手动事务管理，避免与 autocommit 冲突
        # Manual transaction management to avoid autocommit conflicts
        conn.isolation_level = None
        for version, name, up_func in pending:
            log.info("执行迁移 %03d_%s ...", version, name)
            try:
                conn.execute("BEGIN IMMEDIATE")
                up_func(conn)
                conn.execute(
                    "INSERT INTO schema_version (version, name) VALUES (?, ?)",
                    (version, name),
                )
                conn.execute("COMMIT")
                executed += 1
                log.info("迁移 %03d_%s 完成", version, name)
            except Exception as e:
                conn.execute("ROLLBACK")
                log.error("迁移 %03d_%s 失败：%s", version, name, e)
                raise
    finally:
        conn.isolation_level = original_isolation
    return executed


def check_schema(conn: sqlite3.Connection) -> bool:
    """只读检查：schema 是否为最新版本
    Read-only check: whether schema is up to date."""
    try:
        ensure_schema_version_table(conn)
        pending = get_pending_migrations(conn)
        return len(pending) == 0
    except Exception as e:
        log.warning("schema 版本检查异常：%s", e)
        return False
