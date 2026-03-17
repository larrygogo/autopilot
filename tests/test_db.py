"""
数据库层单元测试：CRUD 操作、配置加载
"""
import pytest
from dev_workflow.db import (
    create_task, get_task, get_active_tasks, get_task_logs,
    get_default_branch, now,
)


def _create_test_task(task_id='DB-TEST', workflow='dev'):
    create_task(
        task_id=task_id, req_id='REQ-DB-001', title='DB 测试任务',
        project='test-proj', repo_path='/tmp/test-repo',
        branch='feat/test-DB-TEST',
        agents={'planDesign': 'claude'},
        notify_target='123', channel='telegram',
        workflow=workflow,
    )
    return task_id


class TestCreateAndGetTask:

    def test_create_and_retrieve(self):
        tid = _create_test_task()
        task = get_task(tid)
        assert task is not None
        assert task['title'] == 'DB 测试任务'
        assert task['status'] == 'pending_design'
        assert task['workflow'] == 'dev'
        assert task['rejection_count'] == 0
        assert task['failure_count'] == 0

    def test_get_nonexistent(self):
        assert get_task('NONEXIST') is None

    def test_duplicate_task_raises(self):
        _create_test_task('DUP01')
        with pytest.raises(Exception):
            _create_test_task('DUP01')

    def test_create_with_workflow(self):
        """指定工作流创建任务"""
        tid = _create_test_task('WF-TEST', workflow='req_review')
        task = get_task(tid)
        assert task['workflow'] == 'req_review'
        assert task['status'] == 'pending_analysis'

    def test_rejection_counts_field(self):
        """rejection_counts JSON 字段"""
        import json
        tid = _create_test_task('RC-TEST')
        task = get_task(tid)
        counts = json.loads(task['rejection_counts'])
        assert counts == {}


class TestActiveTasksQuery:

    def test_active_tasks_includes_non_terminal(self):
        _create_test_task('ACT01')
        tasks = get_active_tasks()
        assert len(tasks) == 1
        assert tasks[0]['id'] == 'ACT01'

    def test_active_tasks_excludes_cancelled(self):
        _create_test_task('ACT02')
        from dev_workflow.db import get_conn
        conn = get_conn()
        conn.execute("UPDATE tasks SET status = 'cancelled' WHERE id = 'ACT02'")
        conn.commit()
        tasks = get_active_tasks()
        assert len(tasks) == 0

    def test_active_tasks_excludes_pr_submitted(self):
        _create_test_task('ACT03')
        from dev_workflow.db import get_conn
        conn = get_conn()
        conn.execute("UPDATE tasks SET status = 'pr_submitted' WHERE id = 'ACT03'")
        conn.commit()
        tasks = get_active_tasks()
        assert len(tasks) == 0


class TestTaskLogs:

    def test_logs_recorded_on_transition(self):
        from dev_workflow.state_machine import transition
        tid = _create_test_task('LOG01')
        transition(tid, 'start_design')
        logs = get_task_logs(tid)
        assert len(logs) == 1
        assert logs[0]['trigger'] == 'start_design'
        assert logs[0]['from_status'] == 'pending_design'
        assert logs[0]['to_status'] == 'designing'

    def test_logs_limit(self):
        from dev_workflow.state_machine import transition
        tid = _create_test_task('LOG02')
        transition(tid, 'start_design')
        transition(tid, 'design_complete')
        transition(tid, 'start_review')
        logs = get_task_logs(tid, limit=2)
        assert len(logs) == 2


class TestUtilities:

    def test_now_returns_iso_format(self):
        ts = now()
        assert 'T' in ts
        assert '+' in ts or 'Z' in ts

    def test_get_default_branch(self):
        branch = get_default_branch()
        assert isinstance(branch, str)
        assert len(branch) > 0
