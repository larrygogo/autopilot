"""
迁移引擎测试
"""

from __future__ import annotations

import sqlite3
import textwrap
from unittest import mock

import pytest

import core.migrate as migrate_mod


@pytest.fixture
def conn():
    """独立的内存数据库连接"""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    yield c
    c.close()


class TestSchemaVersionTable:
    def test_create_idempotent(self, conn):
        """schema_version 表创建应幂等"""
        migrate_mod.ensure_schema_version_table(conn)
        migrate_mod.ensure_schema_version_table(conn)
        # 不应抛异常，表应存在
        row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone()
        assert row is not None

    def test_initial_version_is_zero(self, conn):
        """未执行任何迁移时版本应为 0"""
        assert migrate_mod.get_current_version(conn) == 0

    def test_version_after_insert(self, conn):
        """插入版本记录后应返回最大版本"""
        migrate_mod.ensure_schema_version_table(conn)
        conn.execute("INSERT INTO schema_version (version, name) VALUES (1, '001_baseline')")
        conn.execute("INSERT INTO schema_version (version, name) VALUES (2, '002_add_column')")
        assert migrate_mod.get_current_version(conn) == 2


class TestDiscoverMigrations:
    def test_discover_finds_migrations(self):
        """应能发现 core/migrations/ 下的迁移文件"""
        migrations = migrate_mod.discover_migrations()
        assert len(migrations) >= 1
        # 第一个应该是 001_baseline
        assert migrations[0][0] == 1
        assert "baseline" in migrations[0][1]

    def test_discover_sorted_by_version(self):
        """迁移应按版本号排序"""
        migrations = migrate_mod.discover_migrations()
        versions = [v for v, _, _ in migrations]
        assert versions == sorted(versions)

    def test_discover_with_temp_dir(self, tmp_path):
        """从自定义目录发现迁移"""
        # 创建测试迁移文件
        mig = tmp_path / "001_test.py"
        mig.write_text(
            textwrap.dedent("""\
            def up(conn):
                conn.execute("CREATE TABLE test1 (id INTEGER)")
        """)
        )
        mig2 = tmp_path / "002_test2.py"
        mig2.write_text(
            textwrap.dedent("""\
            def up(conn):
                conn.execute("CREATE TABLE test2 (id INTEGER)")
        """)
        )
        # 不应被匹配的文件
        (tmp_path / "__init__.py").write_text("")
        (tmp_path / "helper.py").write_text("x = 1")

        with mock.patch.object(migrate_mod, "MIGRATIONS_DIR", tmp_path):
            migrations = migrate_mod.discover_migrations()
        assert len(migrations) == 2
        assert migrations[0][0] == 1
        assert migrations[0][1] == "test"  # name 只含描述部分
        assert migrations[1][0] == 2

    def test_discover_raises_on_bad_migration(self, tmp_path):
        """加载失败的迁移应抛出异常而非静默跳过"""
        mig = tmp_path / "001_broken.py"
        mig.write_text('raise SyntaxError("bad")')
        with mock.patch.object(migrate_mod, "MIGRATIONS_DIR", tmp_path):
            with pytest.raises(SyntaxError):
                migrate_mod.discover_migrations()


class TestRunMigrations:
    def test_run_baseline(self, conn):
        """执行基线迁移"""
        executed = migrate_mod.run_pending_migrations(conn)
        assert executed >= 1
        assert migrate_mod.get_current_version(conn) >= 1

    def test_idempotent(self, conn):
        """重复执行不应出错"""
        migrate_mod.run_pending_migrations(conn)
        executed = migrate_mod.run_pending_migrations(conn)
        assert executed == 0

    def test_run_with_real_migration(self, conn, tmp_path):
        """执行创建表的真实迁移"""
        mig = tmp_path / "001_create.py"
        mig.write_text(
            textwrap.dedent("""\
            def up(conn):
                conn.execute("CREATE TABLE migrated (id INTEGER PRIMARY KEY, name TEXT)")
        """)
        )
        with mock.patch.object(migrate_mod, "MIGRATIONS_DIR", tmp_path):
            executed = migrate_mod.run_pending_migrations(conn)
        assert executed == 1
        # 验证表已创建
        row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='migrated'").fetchone()
        assert row is not None

    def test_failed_migration_rollback(self, conn, tmp_path):
        """失败的迁移应回滚"""
        mig = tmp_path / "001_bad.py"
        mig.write_text(
            textwrap.dedent("""\
            def up(conn):
                conn.execute("CREATE TABLE good_table (id INTEGER)")
                raise RuntimeError("故意失败")
        """),
            encoding="utf-8",
        )
        with mock.patch.object(migrate_mod, "MIGRATIONS_DIR", tmp_path):
            with pytest.raises(RuntimeError, match="故意失败"):
                migrate_mod.run_pending_migrations(conn)
        # 版本应不变
        assert migrate_mod.get_current_version(conn) == 0
        # 表应不存在（已回滚）
        row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='good_table'").fetchone()
        assert row is None

    def test_partial_success(self, conn, tmp_path):
        """第二个迁移失败时，第一个应已提交"""
        mig1 = tmp_path / "001_ok.py"
        mig1.write_text(
            textwrap.dedent("""\
            def up(conn):
                conn.execute("CREATE TABLE ok_table (id INTEGER)")
        """),
            encoding="utf-8",
        )
        mig2 = tmp_path / "002_bad.py"
        mig2.write_text(
            textwrap.dedent("""\
            def up(conn):
                raise RuntimeError("第二个失败")
        """),
            encoding="utf-8",
        )
        with mock.patch.object(migrate_mod, "MIGRATIONS_DIR", tmp_path):
            with pytest.raises(RuntimeError):
                migrate_mod.run_pending_migrations(conn)
        # 第一个迁移应已提交
        assert migrate_mod.get_current_version(conn) == 1
        row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_table'").fetchone()
        assert row is not None


class TestCheckSchema:
    def test_up_to_date(self, conn):
        """执行所有迁移后 check_schema 应返回 True"""
        migrate_mod.run_pending_migrations(conn)
        assert migrate_mod.check_schema(conn) is True

    def test_behind(self, conn):
        """有待执行迁移时 check_schema 应返回 False"""
        # 不执行任何迁移，应有 pending
        assert migrate_mod.check_schema(conn) is False
