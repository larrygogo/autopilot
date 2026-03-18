"""
状态机单元测试：合法/非法转换、驳回计数
"""
import pytest
from core.db import create_task, get_task
from core.state_machine import (
    transition, InvalidTransitionError, can_transition,
    get_available_triggers,
)
from core.registry import build_transitions, get_all_states, get_terminal_states


def _create_test_task(task_id='TEST01', workflow='dev'):
    create_task(
        task_id=task_id, req_id='REQ-TEST-001', title='测试任务',
        project='test-proj', repo_path='/tmp/test-repo',
        branch='feat/test-TEST01',
        agents={'planDesign': 'claude', 'planReview': 'claude',
                'development': 'claude', 'codeReview': 'claude'},
        notify_target='123', channel='telegram',
        workflow=workflow,
    )
    return task_id


class TestLegalTransitions:
    """合法状态转换"""

    def test_full_happy_path(self):
        """完整的成功路径：pending_design → ... → pr_submitted"""
        tid = _create_test_task()
        transitions = [
            'start_design', 'design_complete', 'start_review',
            'review_pass', 'start_dev', 'dev_complete',
            'code_pass',
        ]
        expected_states = [
            'designing', 'pending_review', 'reviewing',
            'developing', 'in_development', 'code_reviewing',
            'pr_submitted',
        ]
        for trigger, expected in zip(transitions, expected_states):
            _, to_status = transition(tid, trigger)
            assert to_status == expected

        task = get_task(tid)
        assert task['status'] == 'pr_submitted'

    def test_design_fail_and_retry(self):
        """设计失败后自动回退"""
        tid = _create_test_task()
        transition(tid, 'start_design')
        transition(tid, 'design_fail')
        task = get_task(tid)
        assert task['status'] == 'pending_design'

    def test_review_reject_and_retry(self):
        """评审驳回后重新设计"""
        tid = _create_test_task()
        for t in ['start_design', 'design_complete', 'start_review', 'review_reject']:
            transition(tid, t)

        task = get_task(tid)
        assert task['status'] == 'review_rejected'

        transition(tid, 'retry_design')
        task = get_task(tid)
        assert task['status'] == 'pending_design'

    def test_code_reject_and_retry(self):
        """代码审查驳回后返工"""
        tid = _create_test_task()
        for t in ['start_design', 'design_complete', 'start_review',
                   'review_pass', 'start_dev', 'dev_complete', 'code_reject']:
            transition(tid, t)

        task = get_task(tid)
        assert task['status'] == 'code_rejected'

        transition(tid, 'retry_dev')
        task = get_task(tid)
        assert task['status'] == 'in_development'


class TestIllegalTransitions:
    """非法状态转换"""

    def test_invalid_trigger_from_pending_design(self):
        tid = _create_test_task()
        with pytest.raises(InvalidTransitionError):
            transition(tid, 'review_pass')

    def test_invalid_trigger_from_designing(self):
        tid = _create_test_task()
        transition(tid, 'start_design')
        with pytest.raises(InvalidTransitionError):
            transition(tid, 'start_review')

    def test_cannot_transition_from_terminal(self):
        """终态不可再转换"""
        tid = _create_test_task()
        transition(tid, 'cancel')
        with pytest.raises(InvalidTransitionError):
            transition(tid, 'start_design')

    def test_nonexistent_task(self):
        with pytest.raises(ValueError, match='任务不存在'):
            transition('NONEXIST', 'start_design')


class TestCancelFromAnyState:
    """所有非终态都可以取消"""

    def test_cancel_from_pending_design(self):
        tid = _create_test_task()
        _, to = transition(tid, 'cancel')
        assert to == 'cancelled'

    def test_cancel_from_designing(self):
        tid = _create_test_task()
        transition(tid, 'start_design')
        _, to = transition(tid, 'cancel')
        assert to == 'cancelled'

    def test_cancel_from_in_development(self):
        tid = _create_test_task()
        for t in ['start_design', 'design_complete', 'start_review',
                   'review_pass', 'start_dev']:
            transition(tid, t)
        _, to = transition(tid, 'cancel')
        assert to == 'cancelled'


class TestExtraUpdates:
    """extra_updates 参数测试"""

    def test_rejection_count_update(self):
        tid = _create_test_task()
        for t in ['start_design', 'design_complete', 'start_review']:
            transition(tid, t)
        transition(tid, 'review_reject', extra_updates={'rejection_count': 1})
        task = get_task(tid)
        assert task['rejection_count'] == 1

    def test_rejection_counts_json_update(self):
        """新的 JSON 格式驳回计数"""
        import json
        tid = _create_test_task()
        for t in ['start_design', 'design_complete', 'start_review']:
            transition(tid, t)
        counts = json.dumps({'design': 1})
        transition(tid, 'review_reject', extra_updates={'rejection_counts': counts})
        task = get_task(tid)
        assert json.loads(task['rejection_counts']) == {'design': 1}


class TestHelperFunctions:
    """辅助函数测试"""

    def test_can_transition_true(self):
        tid = _create_test_task()
        assert can_transition(tid, 'start_design') is True

    def test_can_transition_false(self):
        tid = _create_test_task()
        assert can_transition(tid, 'review_pass') is False

    def test_can_transition_nonexistent(self):
        assert can_transition('NOPE', 'start_design') is False

    def test_get_available_triggers(self):
        tid = _create_test_task()
        triggers = get_available_triggers(tid)
        assert 'start_design' in triggers
        assert 'cancel' in triggers

    def test_all_states_have_transitions_or_are_terminal(self):
        """验证 dev 工作流转换表的完整性（通过 registry）"""
        terminals = set(get_terminal_states('dev'))
        transitions = build_transitions('dev')
        # 收集转换表中涉及的所有状态（源 + 目标）
        all_states = set(transitions.keys())
        for pairs in transitions.values():
            for _, dest in pairs:
                all_states.add(dest)
        for state in all_states:
            if state in terminals:
                assert state not in transitions or transitions[state] == []
            else:
                assert state in transitions
                assert len(transitions[state]) > 0


class TestDynamicTransitions:
    """动态转换表测试"""

    def test_transition_with_explicit_table(self):
        """使用外部传入的转换表"""
        tid = _create_test_task()
        custom = {
            'pending_design': [('start_design', 'designing'), ('cancel', 'cancelled')],
            'designing': [('design_complete', 'pending_review'), ('cancel', 'cancelled')],
        }
        _, to = transition(tid, 'start_design', transitions=custom)
        assert to == 'designing'

    def test_workflow_field_persisted(self):
        """workflow 字段正确存储"""
        tid = _create_test_task()
        task = get_task(tid)
        assert task['workflow'] == 'dev'
