"""
任务列表与统计查询单元测试
"""

from core.db import create_task, get_task_stats, list_tasks


def _create_sample_task(
    task_id: str, workflow: str = "dev", status: str = "pending_design", project: str = "proj1"
) -> None:
    """创建样本任务"""
    create_task(
        task_id=task_id,
        req_id=f"REQ-{task_id}",
        title=f"Task {task_id}",
        project=project,
        repo_path="/tmp/repo",
        branch=f"feat/{task_id}",
        agents={},
        notify_target="",
        channel="log",
        workflow=workflow,
        initial_status=status,
    )


class TestListTasks:
    """list_tasks 过滤和分页"""

    def test_empty_db(self):
        assert list_tasks() == []

    def test_list_all(self):
        _create_sample_task("t1")
        _create_sample_task("t2")
        result = list_tasks()
        assert len(result) == 2

    def test_filter_by_status(self):
        _create_sample_task("t1", status="pending_design")
        _create_sample_task("t2", status="cancelled")
        result = list_tasks(status="pending_design")
        assert len(result) == 1
        assert result[0]["id"] == "t1"

    def test_filter_by_workflow(self):
        _create_sample_task("t1", workflow="dev")
        _create_sample_task("t2", workflow="req_review", status="pending_analysis")
        result = list_tasks(workflow="req_review")
        assert len(result) == 1
        assert result[0]["workflow"] == "req_review"

    def test_filter_by_project(self):
        _create_sample_task("t1", project="alpha")
        _create_sample_task("t2", project="beta")
        result = list_tasks(project="alpha")
        assert len(result) == 1

    def test_limit(self):
        for i in range(5):
            _create_sample_task(f"t{i}")
        result = list_tasks(limit=3)
        assert len(result) == 3

    def test_combined_filters(self):
        _create_sample_task("t1", workflow="dev", project="alpha")
        _create_sample_task("t2", workflow="dev", project="beta")
        _create_sample_task("t3", workflow="req_review", project="alpha", status="pending_analysis")
        result = list_tasks(workflow="dev", project="alpha")
        assert len(result) == 1
        assert result[0]["id"] == "t1"


class TestGetTaskStats:
    """get_task_stats 聚合统计"""

    def test_empty_db(self):
        stats = get_task_stats()
        assert stats["total"] == 0
        assert stats["by_status"] == {}
        assert stats["by_workflow"] == {}
        assert stats["success_rate"] == 0.0
        assert stats["avg_duration_seconds"] == 0.0

    def test_basic_stats(self):
        _create_sample_task("t1")
        _create_sample_task("t2")
        stats = get_task_stats()
        assert stats["total"] == 2
        assert stats["by_status"]["pending_design"] == 2
        assert stats["by_workflow"]["dev"] == 2

    def test_success_rate(self):
        _create_sample_task("t1", status="pr_submitted")
        _create_sample_task("t2", status="cancelled")
        _create_sample_task("t3", status="pending_design")
        stats = get_task_stats()
        assert stats["total"] == 3
        # 终态 2 个，成功 1 个 → 50%
        assert stats["success_rate"] == 50.0

    def test_multiple_workflows(self):
        _create_sample_task("t1", workflow="dev")
        _create_sample_task("t2", workflow="req_review", status="pending_analysis")
        stats = get_task_stats()
        assert stats["by_workflow"]["dev"] == 1
        assert stats["by_workflow"]["req_review"] == 1
