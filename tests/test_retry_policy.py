"""
重试策略单元测试
"""

from types import SimpleNamespace

from core.registry import DEFAULT_RETRY_POLICY, _registry, get_retry_policy, register
from core.watcher import _calculate_delay


def _dummy_func(task_id: str) -> None:
    pass


class TestGetRetryPolicy:
    """get_retry_policy 默认值、workflow 级别、phase 覆盖"""

    def test_default_policy_for_unknown_workflow(self):
        policy = get_retry_policy("nonexistent")
        assert policy == DEFAULT_RETRY_POLICY

    def test_default_policy_for_existing_workflow(self):
        """现有工作流无 retry_policy 字段时返回默认值"""
        policy = get_retry_policy("dev")
        assert policy["max_retries"] == DEFAULT_RETRY_POLICY["max_retries"]
        assert policy["backoff"] == DEFAULT_RETRY_POLICY["backoff"]

    def test_workflow_level_override(self):
        """workflow 级别覆盖"""
        mod = SimpleNamespace(
            WORKFLOW={
                "name": "test_retry_wf",
                "phases": [
                    {
                        "name": "s1",
                        "pending_state": "ps1",
                        "running_state": "rs1",
                        "trigger": "t1",
                        "func": _dummy_func,
                    },
                ],
                "initial_state": "ps1",
                "terminal_states": ["done"],
                "retry_policy": {"max_retries": 5, "backoff": "exponential"},
            }
        )
        register(mod)
        try:
            policy = get_retry_policy("test_retry_wf")
            assert policy["max_retries"] == 5
            assert policy["backoff"] == "exponential"
            # 未覆盖的字段保留默认值
            assert policy["delay"] == DEFAULT_RETRY_POLICY["delay"]
            assert policy["stuck_timeout"] == DEFAULT_RETRY_POLICY["stuck_timeout"]
        finally:
            _registry.pop("test_retry_wf", None)

    def test_phase_level_override(self):
        """phase 级别覆盖优先于 workflow 级别"""
        mod = SimpleNamespace(
            WORKFLOW={
                "name": "test_retry_wf2",
                "phases": [
                    {
                        "name": "s1",
                        "pending_state": "ps1",
                        "running_state": "rs1",
                        "trigger": "t1",
                        "func": _dummy_func,
                        "retry_policy": {"max_retries": 10, "stuck_timeout": 1800},
                    },
                ],
                "initial_state": "ps1",
                "terminal_states": ["done"],
                "retry_policy": {"max_retries": 5},
            }
        )
        register(mod)
        try:
            policy = get_retry_policy("test_retry_wf2", "s1")
            assert policy["max_retries"] == 10  # phase 覆盖
            assert policy["stuck_timeout"] == 1800  # phase 覆盖
            assert policy["backoff"] == "fixed"  # 默认值
        finally:
            _registry.pop("test_retry_wf2", None)

    def test_phase_not_found_uses_workflow(self):
        """phase 不存在时只用 workflow 级别"""
        mod = SimpleNamespace(
            WORKFLOW={
                "name": "test_retry_wf3",
                "phases": [
                    {
                        "name": "s1",
                        "pending_state": "ps1",
                        "running_state": "rs1",
                        "trigger": "t1",
                        "func": _dummy_func,
                    },
                ],
                "initial_state": "ps1",
                "terminal_states": ["done"],
                "retry_policy": {"max_retries": 7},
            }
        )
        register(mod)
        try:
            policy = get_retry_policy("test_retry_wf3", "nonexistent")
            assert policy["max_retries"] == 7
        finally:
            _registry.pop("test_retry_wf3", None)


class TestCalculateDelay:
    """_calculate_delay fixed/exponential"""

    def test_fixed_backoff(self):
        policy = {"backoff": "fixed", "delay": 60, "max_delay": 600}
        assert _calculate_delay(policy, 1) == 60
        assert _calculate_delay(policy, 3) == 60
        assert _calculate_delay(policy, 10) == 60

    def test_exponential_backoff(self):
        policy = {"backoff": "exponential", "delay": 60, "max_delay": 600}
        assert _calculate_delay(policy, 1) == 60  # 60 * 2^0
        assert _calculate_delay(policy, 2) == 120  # 60 * 2^1
        assert _calculate_delay(policy, 3) == 240  # 60 * 2^2
        assert _calculate_delay(policy, 4) == 480  # 60 * 2^3

    def test_exponential_capped_at_max(self):
        policy = {"backoff": "exponential", "delay": 60, "max_delay": 300}
        assert _calculate_delay(policy, 5) == 300  # min(60 * 2^4, 300)

    def test_unknown_backoff_uses_fixed(self):
        policy = {"backoff": "unknown", "delay": 30, "max_delay": 600}
        assert _calculate_delay(policy, 3) == 30
