"""
测试配置：使用内存数据库，每个测试独立初始化
"""
import sys
import sqlite3
from pathlib import Path
from unittest import mock

import pytest

# 把 src 加入路径
sys.path.insert(0, str(Path(__file__).parent.parent / 'src'))


@pytest.fixture(autouse=True)
def _in_memory_db(monkeypatch):
    """每个测试使用独立的内存数据库"""
    import dev_workflow.db as db_mod

    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript(db_mod.SCHEMA)

    monkeypatch.setattr(db_mod, '_local', type('FakeLocal', (), {'conn': conn})())
    monkeypatch.setattr(db_mod, 'get_conn', lambda: conn)

    yield conn

    conn.close()


@pytest.fixture(autouse=True)
def _ensure_workflows_registered():
    """确保工作流已注册"""
    import dev_workflow.workflows  # noqa: F401
