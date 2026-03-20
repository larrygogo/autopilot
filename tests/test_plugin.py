"""
插件系统单元测试：注册、发现、查询、边界情况
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from core.plugin import (
    _register_plugin,
    _reset,
    discover,
    get_all_notify_backend_types,
    get_cli_commands,
    get_global_hooks,
    get_notify_backend,
)

# ── 手动注册 ───────────────────────────────────────────


class TestRegisterPlugin:
    def test_register_notify_backends(self):
        handler = MagicMock()
        module = SimpleNamespace(notify_backends={"slack": handler})
        _register_plugin("test", module)

        assert get_notify_backend("slack") is handler
        assert "slack" in get_all_notify_backend_types()

    def test_register_cli_commands(self):
        cmd = MagicMock()
        module = SimpleNamespace(cli_commands=[cmd])
        _register_plugin("test", module)

        commands = get_cli_commands()
        assert cmd in commands

    def test_register_global_hooks(self):
        hook_fn = MagicMock()
        module = SimpleNamespace(global_hooks={"before_phase": hook_fn})
        _register_plugin("test", module)

        hooks = get_global_hooks("before_phase")
        assert hook_fn in hooks

    def test_register_multiple_hooks(self):
        fn1 = MagicMock()
        fn2 = MagicMock()
        _register_plugin("p1", SimpleNamespace(global_hooks={"after_phase": fn1}))
        _register_plugin("p2", SimpleNamespace(global_hooks={"after_phase": fn2}))

        hooks = get_global_hooks("after_phase")
        assert fn1 in hooks
        assert fn2 in hooks
        assert len(hooks) == 2

    def test_register_all_extensions(self):
        handler = MagicMock()
        cmd = MagicMock()
        hook_fn = MagicMock()
        module = SimpleNamespace(
            notify_backends={"custom": handler},
            cli_commands=[cmd],
            global_hooks={"on_phase_error": hook_fn},
        )
        _register_plugin("full", module)

        assert get_notify_backend("custom") is handler
        assert cmd in get_cli_commands()
        assert hook_fn in get_global_hooks("on_phase_error")

    def test_register_empty_module(self):
        """无扩展属性的模块不会报错"""
        module = SimpleNamespace()
        _register_plugin("empty", module)

        assert get_all_notify_backend_types() == set()
        assert get_cli_commands() == []
        assert get_global_hooks("before_phase") == []


# ── 边界情况 ───────────────────────────────────────────


class TestEdgeCases:
    def test_non_callable_notify_backend_ignored(self):
        module = SimpleNamespace(notify_backends={"bad": "not_callable"})
        _register_plugin("bad", module)

        assert get_notify_backend("bad") is None

    def test_invalid_hook_name_ignored(self):
        fn = MagicMock()
        module = SimpleNamespace(global_hooks={"invalid_hook": fn})
        _register_plugin("bad", module)

        assert get_global_hooks("invalid_hook") == []

    def test_non_dict_backends_ignored(self):
        module = SimpleNamespace(notify_backends="not_a_dict")
        _register_plugin("bad", module)

        assert get_all_notify_backend_types() == set()

    def test_non_list_commands_ignored(self):
        module = SimpleNamespace(cli_commands="not_a_list")
        _register_plugin("bad", module)

        assert get_cli_commands() == []

    def test_non_dict_hooks_ignored(self):
        module = SimpleNamespace(global_hooks="not_a_dict")
        _register_plugin("bad", module)

        assert get_global_hooks("before_phase") == []

    def test_get_notify_backend_not_found(self):
        assert get_notify_backend("nonexistent") is None

    def test_get_global_hooks_unknown_name(self):
        assert get_global_hooks("nonexistent") == []


# ── 查询 API 返回副本 ────────────────────────────────────


class TestQueryAPI:
    def test_get_cli_commands_returns_copy(self):
        cmd = MagicMock()
        _register_plugin("test", SimpleNamespace(cli_commands=[cmd]))

        result = get_cli_commands()
        result.clear()
        assert len(get_cli_commands()) == 1  # 原列表不受影响

    def test_get_global_hooks_returns_copy(self):
        fn = MagicMock()
        _register_plugin("test", SimpleNamespace(global_hooks={"before_phase": fn}))

        result = get_global_hooks("before_phase")
        result.clear()
        assert len(get_global_hooks("before_phase")) == 1


# ── discover() ─────────────────────────────────────────


class TestDiscover:
    def _mock_entry_points(self, eps_list):
        """创建兼容 Python 3.9/3.12 的 entry_points mock"""
        mock_ep = MagicMock()
        # Python 3.12+: entry_points(group=...) 直接返回列表
        mock_ep.return_value = eps_list
        # Python 3.9: entry_points() 返回 dict，抛 TypeError 后走 .get()
        # 由于 mock 接受任何参数，直接返回列表即可
        return mock_ep

    def test_discover_idempotent(self):
        """多次调用 discover 只执行一次扫描"""
        mock_ep = self._mock_entry_points([])
        with patch("core.plugin.entry_points", mock_ep):
            discover()
            discover()
            # 第二次调用因 _discovered=True 不会再调 entry_points
            mock_ep.assert_called_once()

    def test_discover_loads_plugin(self):
        handler = MagicMock()
        plugin_module = SimpleNamespace(notify_backends={"test_backend": handler})

        ep = MagicMock()
        ep.name = "test_plugin"
        ep.load.return_value = plugin_module

        with patch("core.plugin.entry_points", self._mock_entry_points([ep])):
            discover()

        assert get_notify_backend("test_backend") is handler

    def test_discover_handles_load_failure(self):
        ep = MagicMock()
        ep.name = "broken_plugin"
        ep.load.side_effect = ImportError("missing dep")

        with patch("core.plugin.entry_points", self._mock_entry_points([ep])):
            discover()  # 不应抛异常

        assert get_all_notify_backend_types() == set()


# ── _reset() ──────────────────────────────────────────


class TestReset:
    def test_reset_clears_all(self):
        handler = MagicMock()
        cmd = MagicMock()
        hook_fn = MagicMock()
        _register_plugin(
            "test",
            SimpleNamespace(
                notify_backends={"x": handler},
                cli_commands=[cmd],
                global_hooks={"before_phase": hook_fn},
            ),
        )

        _reset()

        assert get_notify_backend("x") is None
        assert get_cli_commands() == []
        assert get_global_hooks("before_phase") == []
        assert get_all_notify_backend_types() == set()

    def test_reset_allows_rediscovery(self):
        """reset 后 discover 可以再次执行"""
        mock_ep = MagicMock(return_value=[])
        with patch("core.plugin.entry_points", mock_ep):
            discover()
            _reset()
            discover()
            assert mock_ep.call_count == 2
