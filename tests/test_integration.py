"""
集成测试：模拟完整任务生命周期
- 不依赖外部服务（Claude CLI、ReqGenie、OpenClaw）
- 验证任务创建 → 状态流转 → 驳回重试 → 取消 → 日志完整性
"""

import pytest

from core.db import create_task, get_active_tasks, get_task, get_task_logs
from core.registry import get_terminal_states
from core.state_machine import (
    transition,
)


def _register_task(task_id="INT-001", title="集成测试任务", workflow="dev"):
    """模拟 start_task.py 的任务注册流程"""
    create_task(
        task_id=task_id,
        req_id="REQ-INTEGRATION-001",
        title=title,
        project="test-project",
        repo_path="/tmp/test-repo",
        branch=f"feat/test-project-{task_id}",
        agents={
            "planDesign": "claude",
            "planReview": "codex",
            "development": "claude",
            "codeReview": "codex",
        },
        notify_target="test-chat-id",
        channel="telegram",
        workflow=workflow,
    )
    return task_id


class TestTaskRegistration:
    """场景 1：任务注册"""

    def test_new_task_created_correctly(self):
        tid = _register_task()
        task = get_task(tid)

        assert task is not None
        assert task["status"] == "pending_design"
        assert task["workflow"] == "dev"
        assert task["project"] == "test-project"
        assert task["branch"] == "feat/test-project-INT-001"
        assert task["rejection_count"] == 0
        assert task["code_rejection_count"] == 0
        assert task["failure_count"] == 0
        assert task["pr_url"] is None

    def test_task_appears_in_active_list(self):
        _register_task()
        active = get_active_tasks()
        assert len(active) == 1
        assert active[0]["id"] == "INT-001"

    def test_duplicate_task_rejected(self):
        _register_task("DUP-001")
        with pytest.raises(Exception):
            _register_task("DUP-001")

    def test_task_with_workflow(self):
        """指定工作流注册任务"""
        tid = _register_task("WF-001", workflow="req_review")
        task = get_task(tid)
        assert task["workflow"] == "req_review"
        assert task["status"] == "pending_analysis"


class TestHappyPath:
    """场景 2：完整成功路径（无驳回）"""

    def test_full_lifecycle(self):
        tid = _register_task()
        expected_flow = [
            # (trigger,           expected_status,    description)
            ("start_design", "designing", "开始方案设计"),
            ("design_complete", "pending_review", "方案设计完成"),
            ("start_review", "reviewing", "开始方案评审"),
            ("review_pass", "developing", "方案评审通过"),
            ("start_dev", "in_development", "开始开发"),
            ("dev_complete", "code_reviewing", "开发完成"),
            ("code_pass", "pr_submitted", "PR 已提交"),
        ]

        for trigger, expected_status, desc in expected_flow:
            from_s, to_s = transition(tid, trigger, note=desc)
            task = get_task(tid)
            assert task["status"] == expected_status, f"{desc}: 期望 {expected_status}，实际 {task['status']}"

        # 验证终态
        task = get_task(tid)
        assert task["status"] in get_terminal_states("dev")

        # 验证不再出现在活跃列表中
        active = get_active_tasks()
        assert all(t["id"] != tid for t in active)

        # 验证完整的流转日志
        logs = get_task_logs(tid, limit=100)
        assert len(logs) == 7
        # 验证日志包含所有关键状态（不依赖排序）
        log_targets = {log["to_status"] for log in logs}
        assert "pr_submitted" in log_targets
        assert "designing" in log_targets


class TestDesignRejectAndRetry:
    """场景 3：方案评审驳回 → 自动重新设计 → 再次通过"""

    def test_single_rejection_cycle(self):
        tid = _register_task()

        # 第一轮：设计 → 评审驳回
        for t in ["start_design", "design_complete", "start_review"]:
            transition(tid, t)

        transition(
            tid,
            "review_reject",
            note="方案评审驳回（第1次）",
            extra_updates={"rejection_count": 1, "rejection_reason": "缺少错误处理方案"},
        )

        task = get_task(tid)
        assert task["status"] == "review_rejected"
        assert task["rejection_count"] == 1
        assert task["rejection_reason"] == "缺少错误处理方案"

        # 自动重新设计
        transition(tid, "retry_design")
        assert get_task(tid)["status"] == "pending_design"

        # 第二轮：重新设计 → 评审通过
        for t in ["start_design", "design_complete", "start_review", "review_pass"]:
            transition(tid, t)

        assert get_task(tid)["status"] == "developing"

    def test_max_rejections_triggers_cancel(self):
        """驳回 10 次后自动取消"""
        tid = _register_task()

        for i in range(10):
            for t in ["start_design", "design_complete", "start_review"]:
                transition(tid, t)

            if i < 9:
                transition(tid, "review_reject", extra_updates={"rejection_count": i + 1})
                transition(tid, "retry_design")
            else:
                # 第 10 次：取消
                transition(tid, "cancel", note="方案评审驳回 10 次，已取消", extra_updates={"rejection_count": 10})

        task = get_task(tid)
        assert task["status"] == "cancelled"
        assert task["rejection_count"] == 10


class TestCodeRejectAndRework:
    """场景 4：代码审查驳回 → 自动返工 → 再次通过"""

    def test_code_rejection_rework(self):
        tid = _register_task()

        # 走到代码审查
        for t in ["start_design", "design_complete", "start_review", "review_pass", "start_dev", "dev_complete"]:
            transition(tid, t)

        # 代码审查驳回
        transition(tid, "code_reject", extra_updates={"code_rejection_count": 1, "rejection_reason": "缺少单元测试"})

        task = get_task(tid)
        assert task["status"] == "code_rejected"
        assert task["code_rejection_count"] == 1

        # 返工
        transition(tid, "retry_dev")
        assert get_task(tid)["status"] == "in_development"

        # 再次完成 → 审查通过
        transition(tid, "dev_complete")
        transition(tid, "code_pass")
        assert get_task(tid)["status"] == "pr_submitted"


class TestCancelFromAnyPhase:
    """场景 5：任意阶段手动取消"""

    @pytest.mark.parametrize(
        "setup_triggers,phase_name",
        [
            ([], "pending_design"),
            (["start_design"], "designing"),
            (["start_design", "design_complete"], "pending_review"),
            (["start_design", "design_complete", "start_review"], "reviewing"),
            (["start_design", "design_complete", "start_review", "review_pass"], "developing"),
            (["start_design", "design_complete", "start_review", "review_pass", "start_dev"], "in_development"),
            (
                ["start_design", "design_complete", "start_review", "review_pass", "start_dev", "dev_complete"],
                "code_reviewing",
            ),
        ],
    )
    def test_cancel(self, setup_triggers, phase_name):
        tid = _register_task(f"CAN-{phase_name[:6]}")
        for t in setup_triggers:
            transition(tid, t)

        assert get_task(tid)["status"] == phase_name
        transition(tid, "cancel", note="用户手动取消")

        task = get_task(tid)
        assert task["status"] == "cancelled"
        assert len(get_active_tasks()) == 0


class TestFailureTracking:
    """场景 6：失败计数与恢复"""

    def test_failure_count_persists(self):
        tid = _register_task()
        transition(tid, "start_design")

        # 模拟 watcher 检测到卡死，增加失败计数
        from core.db import get_conn, now

        with get_conn() as conn:
            conn.execute(
                "UPDATE tasks SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?", (now(), tid)
            )

        task = get_task(tid)
        assert task["failure_count"] == 1

        # 模拟回退后重试成功
        transition(tid, "design_fail")
        transition(tid, "start_design")
        transition(tid, "design_complete")

        task = get_task(tid)
        assert task["status"] == "pending_review"
        assert task["failure_count"] == 1  # 失败计数不会被重置


class TestMultipleTasksConcurrent:
    """场景 7：多任务并行"""

    def test_independent_tasks(self):
        tid1 = _register_task("MULTI-01", "任务一")
        tid2 = _register_task("MULTI-02", "任务二")

        # 任务一快速完成
        for t in [
            "start_design",
            "design_complete",
            "start_review",
            "review_pass",
            "start_dev",
            "dev_complete",
            "code_pass",
        ]:
            transition(tid1, t)

        # 任务二在评审阶段
        for t in ["start_design", "design_complete", "start_review"]:
            transition(tid2, t)

        assert get_task(tid1)["status"] == "pr_submitted"
        assert get_task(tid2)["status"] == "reviewing"

        # 活跃列表只包含任务二
        active = get_active_tasks()
        assert len(active) == 1
        assert active[0]["id"] == "MULTI-02"

    def test_different_workflow_tasks(self):
        """不同工作流的任务可以并行"""
        tid1 = _register_task("DEV-01", "开发任务", workflow="dev")
        tid2 = _register_task("REQ-01", "需求评审任务", workflow="req_review")

        assert get_task(tid1)["status"] == "pending_design"
        assert get_task(tid2)["status"] == "pending_analysis"

        # 两个任务都在活跃列表中
        active = get_active_tasks()
        assert len(active) == 2


class TestLogIntegrity:
    """场景 8：日志完整性验证"""

    def test_every_transition_logged(self):
        tid = _register_task()
        triggers = [
            "start_design",
            "design_complete",
            "start_review",
            "review_reject",
            "retry_design",
            "start_design",
            "design_complete",
            "start_review",
            "review_pass",
            "start_dev",
            "dev_complete",
            "code_pass",
        ]

        for t in triggers:
            transition(tid, t, extra_updates=({"rejection_count": 1} if t == "review_reject" else None))

        logs = get_task_logs(tid, limit=100)
        assert len(logs) == len(triggers)

        # 验证日志链连续性：按 id 排序后，每条日志的 to_status == 下一条的 from_status
        logs_asc = sorted(logs, key=lambda entry: entry["id"])
        for i in range(len(logs_asc) - 1):
            to_s = logs_asc[i]["to_status"]
            from_s = logs_asc[i + 1]["from_status"]
            assert to_s == from_s, f"日志链断裂：第{i}条 to={to_s} != 第{i + 1}条 from={from_s}"


class TestReqReviewWorkflow:
    """场景 10：需求评审工作流"""

    def test_req_review_happy_path(self):
        """需求评审完整路径"""
        tid = _register_task("RR-001", "需求评审测试", workflow="req_review")
        task = get_task(tid)
        assert task["status"] == "pending_analysis"
        assert task["workflow"] == "req_review"

        # 分析 → 评审通过
        transition(tid, "start_analysis")
        assert get_task(tid)["status"] == "analyzing"

        transition(tid, "analysis_complete")
        assert get_task(tid)["status"] == "pending_req_review"

        transition(tid, "start_req_review")
        assert get_task(tid)["status"] == "req_reviewing"

        transition(tid, "req_review_pass")
        assert get_task(tid)["status"] == "req_review_done"

    def test_req_review_reject_and_retry(self):
        """需求评审驳回 → 重新分析"""
        tid = _register_task("RR-002", "需求评审驳回测试", workflow="req_review")

        for t in ["start_analysis", "analysis_complete", "start_req_review"]:
            transition(tid, t)

        transition(tid, "req_review_reject")
        assert get_task(tid)["status"] == "req_review_rejected"

        transition(tid, "retry_req_analysis")
        assert get_task(tid)["status"] == "pending_analysis"

    def test_req_review_cancel(self):
        """需求评审任务取消"""
        tid = _register_task("RR-003", "需求评审取消测试", workflow="req_review")
        transition(tid, "start_analysis")
        transition(tid, "cancel")
        assert get_task(tid)["status"] == "cancelled"
