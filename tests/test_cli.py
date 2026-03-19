"""
CLI 命令测试：使用 click.testing.CliRunner 测试所有 CLI 命令
"""

from __future__ import annotations

from unittest import mock

import pytest
from click.testing import CliRunner

from core.cli import main
from core.db import create_task


@pytest.fixture
def runner():
    return CliRunner()


def _create_test_task(task_id="CLI-001", workflow="dev"):
    """在测试数据库中创建任务"""
    create_task(
        task_id=task_id,
        req_id="REQ-CLI-001",
        title="CLI 测试任务",
        project="test-project",
        repo_path="/tmp/test-repo",
        branch="feat/test",
        agents={},
        notify_target="",
        channel="log",
        workflow=workflow,
    )


# ──────────────────────────────────────────────────────────
# validate
# ──────────────────────────────────────────────────────────


class TestValidateCommand:
    def test_validate_all(self, runner):
        """无参数 → 校验所有已注册工作流 → exit 0"""
        result = runner.invoke(main, ["validate"])
        assert result.exit_code == 0
        assert "dev" in result.output
        assert "req_review" in result.output

    def test_validate_specific(self, runner):
        """指定已注册名 → exit 0"""
        result = runner.invoke(main, ["validate", "dev"])
        assert result.exit_code == 0
        assert "dev" in result.output
        assert "通过" in result.output

    def test_validate_nonexistent(self, runner):
        """不存在 → exit 1"""
        result = runner.invoke(main, ["validate", "nonexistent_workflow"])
        assert result.exit_code == 1


# ──────────────────────────────────────────────────────────
# workflows
# ──────────────────────────────────────────────────────────


class TestWorkflowsCommand:
    def test_list_registered(self, runner):
        """输出包含 dev, req_review"""
        result = runner.invoke(main, ["workflows"])
        assert result.exit_code == 0
        assert "dev" in result.output
        assert "req_review" in result.output


# ──────────────────────────────────────────────────────────
# start
# ──────────────────────────────────────────────────────────


class TestStartCommand:
    def test_start_creates_task(self, runner):
        """创建任务成功（mock execute_phase）"""
        with mock.patch("core.runner.execute_phase"):
            result = runner.invoke(main, ["start", "REQ-START-001", "--workflow", "dev", "--title", "测试"])
            assert result.exit_code == 0
            assert "已注册" in result.output

    def test_start_unknown_workflow(self, runner):
        """不存在工作流 → exit 1"""
        result = runner.invoke(main, ["start", "REQ-001", "--workflow", "nonexistent"])
        assert result.exit_code == 1

    def test_start_duplicate_task(self, runner):
        """重复任务 → exit 0"""
        _create_test_task("REQ-DUPL")
        result = runner.invoke(main, ["start", "REQ-DUPL-xxxxx", "--workflow", "dev"])
        assert result.exit_code == 0
        assert "已存在" in result.output


# ──────────────────────────────────────────────────────────
# list
# ──────────────────────────────────────────────────────────


class TestListCommand:
    def test_list_empty(self, runner):
        """空库 → 暂无任务"""
        result = runner.invoke(main, ["list"])
        assert result.exit_code == 0
        assert "暂无任务" in result.output

    def test_list_with_tasks(self, runner):
        """有任务 → 输出 ID"""
        _create_test_task("LST-001")
        result = runner.invoke(main, ["list"])
        assert result.exit_code == 0
        assert "LST-001" in result.output


# ──────────────────────────────────────────────────────────
# show
# ──────────────────────────────────────────────────────────


class TestShowCommand:
    def test_show_existing(self, runner):
        """存在 → 显示详情"""
        _create_test_task("SHW-001")
        with mock.patch("core.infra.is_locked", return_value=False):
            result = runner.invoke(main, ["show", "SHW-001"])
        assert result.exit_code == 0
        assert "SHW-001" in result.output
        assert "dev" in result.output

    def test_show_nonexistent(self, runner):
        """不存在 → exit 1"""
        result = runner.invoke(main, ["show", "NONEXIST"])
        assert result.exit_code == 1


# ──────────────────────────────────────────────────────────
# cancel
# ──────────────────────────────────────────────────────────


class TestCancelCommand:
    def test_cancel_active(self, runner):
        """取消成功"""
        _create_test_task("CAN-001")
        with mock.patch("core.infra.notify"):
            result = runner.invoke(main, ["cancel", "CAN-001"])
        assert result.exit_code == 0
        assert "已取消" in result.output

    def test_cancel_nonexistent(self, runner):
        """不存在 → exit 1"""
        result = runner.invoke(main, ["cancel", "NONEXIST"])
        assert result.exit_code == 1


# ──────────────────────────────────────────────────────────
# stats
# ──────────────────────────────────────────────────────────


class TestStatsCommand:
    def test_stats_output(self, runner):
        """输出包含任务总数"""
        result = runner.invoke(main, ["stats"])
        assert result.exit_code == 0
        assert "任务总数" in result.output
