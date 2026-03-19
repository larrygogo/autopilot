"""
工作流注册表单元测试
"""

from core.registry import (
    build_transitions,
    get_all_states,
    get_next_phase,
    get_pending_state_phase,
    get_phase,
    get_phase_func,
    get_running_state_phase,
    get_terminal_states,
    get_workflow,
    list_workflows,
)


class TestDiscovery:
    """工作流发现与注册"""

    def test_dev_workflow_registered(self):
        wf = get_workflow("dev")
        assert wf is not None
        assert wf["name"] == "dev"

    def test_req_review_workflow_registered(self):
        wf = get_workflow("req_review")
        assert wf is not None
        assert wf["name"] == "req_review"

    def test_nonexistent_workflow(self):
        assert get_workflow("nonexistent") is None

    def test_list_workflows(self):
        wfs = list_workflows()
        names = [w["name"] for w in wfs]
        assert "dev" in names
        assert "req_review" in names


class TestPhaseQuery:
    """阶段查询"""

    def test_get_phase(self):
        phase = get_phase("dev", "design")
        assert phase is not None
        assert phase["name"] == "design"
        assert phase["label"] == "PLAN_DESIGN"
        assert phase["trigger"] == "start_design"

    def test_get_phase_nonexistent(self):
        assert get_phase("dev", "nonexistent") is None
        assert get_phase("nonexistent", "design") is None

    def test_get_phase_func(self):
        func = get_phase_func("dev", "design")
        assert func is not None
        assert callable(func)

    def test_get_next_phase(self):
        assert get_next_phase("dev", "design") == "review"
        assert get_next_phase("dev", "review") == "dev"
        assert get_next_phase("dev", "pr") is None  # 最后阶段无下一阶段


class TestBuildTransitions:
    """转换表构建"""

    def test_dev_transitions_match_workflow_definition(self):
        """dev 工作流的转换表与 WORKFLOW['transitions'] 一致"""
        wf = get_workflow("dev")
        transitions = build_transitions("dev")
        assert transitions == wf["transitions"]

    def test_req_review_transitions(self):
        transitions = build_transitions("req_review")
        assert "pending_analysis" in transitions
        assert "analyzing" in transitions
        assert "req_reviewing" in transitions

        # 验证 cancel 可用
        assert any(t == "cancel" for t, _ in transitions["pending_analysis"])
        assert any(t == "cancel" for t, _ in transitions["analyzing"])

    def test_nonexistent_workflow_returns_empty(self):
        assert build_transitions("nonexistent") == {}


class TestStateMappings:
    """状态映射"""

    def test_running_state_phase(self):
        mapping = get_running_state_phase("dev")
        assert mapping["designing"] == "design"
        assert mapping["reviewing"] == "review"
        assert mapping["in_development"] == "dev"

    def test_pending_state_phase(self):
        mapping = get_pending_state_phase("dev")
        assert mapping["pending_design"] == "design"
        assert mapping["pending_review"] == "review"

    def test_all_states(self):
        states = get_all_states("dev")
        assert "pending_design" in states
        assert "designing" in states
        assert "pr_submitted" in states
        assert "cancelled" in states

    def test_terminal_states(self):
        terminals = get_terminal_states("dev")
        assert "pr_submitted" in terminals
        assert "cancelled" in terminals

    def test_req_review_terminal_states(self):
        terminals = get_terminal_states("req_review")
        assert "req_review_done" in terminals
        assert "cancelled" in terminals
