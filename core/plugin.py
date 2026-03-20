"""
插件系统：通过 entry_points 发现并注册第三方扩展。

扩展点：
- notify_backends：注册新的通知后端类型
- cli_commands：注册新的 CLI 子命令
- global_hooks：注册跨工作流的 before_phase / after_phase / on_phase_error 钩子

第三方包通过 entry_points 注册：
    [project.entry-points."autopilot.plugins"]
    my_plugin = "my_package.plugin_module"

插件模块通过鸭子类型暴露扩展（均可选）：
- notify_backends: dict[str, Callable]
- cli_commands: list[click.BaseCommand]
- global_hooks: dict[str, Callable]
"""

from __future__ import annotations

from typing import Any, Callable

try:
    from importlib.metadata import entry_points
except ImportError:
    entry_points = None  # type: ignore[assignment]

from core.logger import get_logger

log = get_logger()

# ── 注册表 ──────────────────────────────────────────────

_notify_backends: dict[str, Callable] = {}
_cli_commands: list[Any] = []
_global_hooks: dict[str, list[Callable]] = {
    "before_phase": [],
    "after_phase": [],
    "on_phase_error": [],
}

_discovered = False

# ── 发现与注册 ──────────────────────────────────────────


def discover() -> None:
    """扫描 entry_points(group='autopilot.plugins') 并注册扩展，幂等。"""
    global _discovered
    if _discovered:
        return
    _discovered = True

    if entry_points is None:
        return

    try:
        eps = entry_points(group="autopilot.plugins")
    except TypeError:
        # Python 3.9 兼容：entry_points() 不支持 group 关键字
        eps = entry_points().get("autopilot.plugins", [])

    for ep in eps:
        try:
            plugin_module = ep.load()
            _register_plugin(ep.name, plugin_module)
        except Exception as e:
            log.warning("插件 %s 加载失败：%s", ep.name, e)


def _register_plugin(name: str, module: Any) -> None:
    """通过 getattr 鸭子类型从插件模块中提取扩展。"""
    # 通知后端
    backends = getattr(module, "notify_backends", None)
    if isinstance(backends, dict):
        for backend_type, factory in backends.items():
            if callable(factory):
                _notify_backends[backend_type] = factory
                log.debug("插件 %s 注册通知后端：%s", name, backend_type)

    # CLI 命令
    commands = getattr(module, "cli_commands", None)
    if isinstance(commands, list):
        for cmd in commands:
            _cli_commands.append(cmd)
            log.debug("插件 %s 注册 CLI 命令", name)

    # 全局钩子
    hooks = getattr(module, "global_hooks", None)
    if isinstance(hooks, dict):
        for hook_name, func in hooks.items():
            if hook_name in _global_hooks and callable(func):
                _global_hooks[hook_name].append(func)
                log.debug("插件 %s 注册全局钩子：%s", name, hook_name)


# ── 查询 API ───────────────────────────────────────────


def get_notify_backend(backend_type: str) -> Callable | None:
    """查询插件注册的通知后端，未找到返回 None。"""
    return _notify_backends.get(backend_type)


def get_all_notify_backend_types() -> set[str]:
    """返回所有插件注册的通知后端类型名集合。"""
    return set(_notify_backends.keys())


def get_cli_commands() -> list[Any]:
    """返回所有插件注册的 CLI 命令。"""
    return list(_cli_commands)


def get_global_hooks(hook_name: str) -> list[Callable]:
    """返回指定名称的全局钩子列表。"""
    return list(_global_hooks.get(hook_name, []))


# ── 测试辅助 ───────────────────────────────────────────


def _reset() -> None:
    """重置所有注册表（仅供测试使用）。"""
    global _discovered
    _discovered = False
    _notify_backends.clear()
    _cli_commands.clear()
    for hook_list in _global_hooks.values():
        hook_list.clear()
