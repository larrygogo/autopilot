"""
用户工作流发现测试：tmp_path 发现、同名覆盖、畸形文件、_ 前缀忽略
"""

import sys
from unittest import mock

from core.registry import _discover_user, _registry


def _make_workflow_file(wf_dir, name, content=None):
    """在 wf_dir 中创建工作流文件"""
    if content is None:
        content = f"""
def _phase(task_id):
    pass

WORKFLOW = {{
    'name': '{name}',
    'description': '测试工作流 {name}',
    'phases': [{{
        'name': 'step1',
        'pending_state': 'pending',
        'running_state': 'running',
        'trigger': 'start',
        'func': _phase,
    }}],
    'initial_state': 'pending',
    'terminal_states': ['done', 'cancelled'],
}}
"""
    f = wf_dir / f"{name}.py"
    f.write_text(content, encoding="utf-8")
    return f


class TestUserWorkflowDiscovery:
    """用户工作流发现"""

    def test_discover_from_tmp_path(self, tmp_path):
        """从 tmp_path 发现用户工作流"""
        wf_dir = tmp_path / "workflows"
        wf_dir.mkdir()
        _make_workflow_file(wf_dir, "custom_wf")

        # 清理可能的缓存模块
        to_remove = [k for k in sys.modules if k.startswith("devpilot_user_wf_")]
        for k in to_remove:
            del sys.modules[k]

        with mock.patch("core.AUTOPILOT_HOME", tmp_path):
            old_registry = dict(_registry)
            try:
                _discover_user()
                assert "custom_wf" in _registry
            finally:
                _registry.clear()
                _registry.update(old_registry)

    def test_user_overrides_existing(self, tmp_path):
        """同名用户工作流覆盖已注册"""
        wf_dir = tmp_path / "workflows"
        wf_dir.mkdir()
        _make_workflow_file(wf_dir, "dev")  # 同名覆盖内置 dev

        to_remove = [k for k in sys.modules if k.startswith("devpilot_user_wf_")]
        for k in to_remove:
            del sys.modules[k]

        with mock.patch("core.AUTOPILOT_HOME", tmp_path):
            old_registry = dict(_registry)
            try:
                _discover_user()
                # dev 工作流被覆盖
                assert "dev" in _registry
                mod = _registry["dev"]
                assert mod.WORKFLOW["description"] == "测试工作流 dev"
            finally:
                _registry.clear()
                _registry.update(old_registry)

    def test_malformed_file_skipped(self, tmp_path):
        """畸形文件跳过不影响其他"""
        wf_dir = tmp_path / "workflows"
        wf_dir.mkdir()
        # 畸形文件
        bad_file = wf_dir / "bad.py"
        bad_file.write_text("WORKFLOW = 'not a dict'\n", encoding="utf-8")
        # 正常文件
        _make_workflow_file(wf_dir, "good_wf")

        to_remove = [k for k in sys.modules if k.startswith("devpilot_user_wf_")]
        for k in to_remove:
            del sys.modules[k]

        with mock.patch("core.AUTOPILOT_HOME", tmp_path):
            old_registry = dict(_registry)
            try:
                _discover_user()
                assert "good_wf" in _registry
                # bad 不应该注册
                names = [m.WORKFLOW.get("name", "") for m in _registry.values() if hasattr(m, "WORKFLOW")]
                assert "not a dict" not in names
            finally:
                _registry.clear()
                _registry.update(old_registry)

    def test_underscore_prefix_ignored(self, tmp_path):
        """_ 前缀文件被忽略"""
        wf_dir = tmp_path / "workflows"
        wf_dir.mkdir()
        _make_workflow_file(wf_dir, "_private")

        to_remove = [k for k in sys.modules if k.startswith("devpilot_user_wf_")]
        for k in to_remove:
            del sys.modules[k]

        with mock.patch("core.AUTOPILOT_HOME", tmp_path):
            old_registry = dict(_registry)
            try:
                _discover_user()
                assert "_private" not in _registry
            finally:
                _registry.clear()
                _registry.update(old_registry)

    def test_no_workflows_dir(self, tmp_path):
        """没有 workflows 目录不报错"""
        with mock.patch("core.AUTOPILOT_HOME", tmp_path):
            old_registry = dict(_registry)
            try:
                _discover_user()  # 不应抛异常
            finally:
                _registry.clear()
                _registry.update(old_registry)
