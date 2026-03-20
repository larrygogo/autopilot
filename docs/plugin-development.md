# 插件开发指南

本文档指导你如何为 autopilot 开发第三方插件，通过 `pip install` 自动注册扩展，无需修改框架代码。

## 工作原理

```
pip install autopilot-openclaw
        │
        ▼
  pyproject.toml 声明 entry_points
        │
        ▼
  框架启动时 importlib.metadata.entry_points(group="autopilot.plugins")
        │
        ▼
  加载插件模块，通过鸭子类型提取扩展
        │
        ├── notify_backends → 注册到通知分发
        ├── cli_commands    → 注册到 CLI 命令组
        └── global_hooks    → 注册到执行引擎钩子
```

框架在 `core/workflows/__init__.py` 中自动调用 `discover_plugins()`，扫描所有已安装包的 `autopilot.plugins` entry_points。发现过程**幂等**，单个插件加载失败只记日志，不影响其他插件和框架运行。

## 三个扩展点

| 扩展点 | 属性名 | 类型 | 说明 |
|--------|--------|------|------|
| 通知后端 | `notify_backends` | `dict[str, Callable]` | 注册新的通知类型（扩展 webhook/command） |
| CLI 命令 | `cli_commands` | `list[click.BaseCommand]` | 注册新的 `autopilot` 子命令 |
| 全局钩子 | `global_hooks` | `dict[str, Callable]` | 注册跨工作流的阶段钩子 |

所有属性均**可选**，插件可以只实现其中一个或多个。

## 快速开始

### 1. 项目结构

```
autopilot-openclaw/
├── pyproject.toml
└── autopilot_openclaw/
    ├── __init__.py          # 插件入口模块
    ├── notify.py            # 通知后端实现（可选）
    ├── commands.py          # CLI 命令实现（可选）
    └── hooks.py             # 全局钩子实现（可选）
```

### 2. pyproject.toml

```toml
[project]
name = "autopilot-openclaw"
version = "0.1.0"
dependencies = ["autopilot"]

[project.entry-points."autopilot.plugins"]
openclaw = "autopilot_openclaw"
```

`entry_points` 的 key（`openclaw`）是插件名称，value 指向插件入口模块。

### 3. 插件入口模块

```python
# autopilot_openclaw/__init__.py

from autopilot_openclaw.notify import send_openclaw
from autopilot_openclaw.commands import status_cmd
from autopilot_openclaw.hooks import audit_hook

# 通知后端：key 是后端类型名，value 是发送函数
notify_backends = {
    "openclaw": send_openclaw,
}

# CLI 命令：click 命令对象列表
cli_commands = [status_cmd]

# 全局钩子：key 必须是 before_phase / after_phase / on_phase_error
global_hooks = {
    "after_phase": audit_hook,
}
```

---

## 扩展点详解

### 通知后端

注册新的通知类型，工作流在 `notify_backends` 配置中使用自定义 `type`。

**函数签名：**

```python
def send_openclaw(backend: dict, variables: dict[str, str]) -> None:
    """
    Args:
        backend: 工作流 notify_backends 中的后端配置字典，包含 type 和自定义字段
        variables: 模板变量，包含 message, event, task_id, title, workflow 等
    """
```

**工作流配置示例：**

```yaml
notify_backends:
  - type: openclaw           # 匹配插件注册的类型名
    api_key: "${OPENCLAW_KEY}"
    channel: "dev-alerts"
    events: ["success", "error"]
```

**实现示例：**

```python
# autopilot_openclaw/notify.py
import urllib.request
import json

from core.notify import expand_env_vars

def send_openclaw(backend: dict, variables: dict[str, str]) -> None:
    # 插件需自行调用 expand_env_vars() 展开 ${VAR} 引用
    api_key = expand_env_vars(backend.get("api_key", ""))
    channel = backend.get("channel", "default")
    payload = json.dumps({
        "channel": channel,
        "text": variables.get("message", ""),
        "task_id": variables.get("task_id", ""),
    }).encode()

    req = urllib.request.Request(
        "https://api.openclaw.dev/notify",
        data=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=10)
```

通知分发流程：`core/notify.dispatch()` 先检查内置类型（webhook/command），未匹配时查询插件注册的后端。插件后端类型也会被 `validate_backends()` 识别为合法类型。

> **注意**：内置 webhook/command 后端会自动展开 `${VAR}` 环境变量，但插件后端收到的是**原始配置字典**，需自行调用 `expand_env_vars()` 处理。

### CLI 命令

注册新的 `autopilot` 子命令，基于 [click](https://click.palletsprojects.com/) 框架。

**实现示例：**

```python
# autopilot_openclaw/commands.py
import click

@click.command("openclaw")
@click.argument("action", type=click.Choice(["status", "config"]))
def status_cmd(action):
    """OpenClaw 插件管理"""
    if action == "status":
        click.echo("OpenClaw 连接正常")
    elif action == "config":
        click.echo("当前配置：...")
```

也可以注册命令组：

```python
@click.group("openclaw")
def openclaw_group():
    """OpenClaw 插件"""
    pass

@openclaw_group.command()
def status():
    """查看 OpenClaw 状态"""
    click.echo("OK")

@openclaw_group.command()
def sync():
    """同步数据"""
    click.echo("Syncing...")

# 入口模块中
cli_commands = [openclaw_group]
```

注册后即可使用：

```bash
autopilot openclaw status
autopilot openclaw sync
```

### 全局钩子

注册跨**所有工作流**的 `before_phase` / `after_phase` / `on_phase_error` 钩子。

全局钩子在工作流级钩子**之后**执行，每个钩子独立 `try/except`，异常只记日志不中断主流程。

**函数签名：**

```python
def my_before_phase(task_id: str, phase: str) -> None: ...
def my_after_phase(task_id: str, phase: str) -> None: ...
def my_on_phase_error(task_id: str, phase: str, error: Exception) -> None: ...
```

**实现示例：**

```python
# autopilot_openclaw/hooks.py
from core.db import get_task
from core.logger import get_logger

log = get_logger()

def audit_hook(task_id: str, phase: str) -> None:
    """阶段完成后记录审计日志"""
    task = get_task(task_id)
    if not task:
        return
    log.info("[审计] 任务 %s 完成阶段 %s，当前状态：%s",
             task_id, phase, task["status"])
```

**执行顺序：**

```
execute_phase()
  │
  ├── _invoke_hook("before_phase")
  │     ├── workflow hooks.before_phase()     ← 工作流级（workflow.yaml 中定义）
  │     └── plugin global_hooks.before_phase  ← 插件全局钩子（依次执行，独立 try/except）
  │
  ├── phase_func()                            ← 阶段函数执行
  │
  └── _invoke_hook("after_phase")
        ├── workflow hooks.after_phase()
        └── plugin global_hooks.after_phase
```

---

## 插件中访问框架 API

插件是普通 Python 包，可以直接 import 框架模块：

```python
from core.db import get_task, list_tasks, get_active_tasks, get_task_stats, get_sub_tasks, get_task_logs
from core.registry import get_workflow, list_workflows
from core.notify import expand_env_vars
from core.config import load_config
from core.logger import get_logger
```

**常用查询 API：**

| 函数 | 用途 |
|------|------|
| `get_task(task_id)` | 获取单个任务详情（含 extra 字段） |
| `list_tasks(status, workflow, limit)` | 按条件查询任务列表 |
| `get_active_tasks()` | 获取所有活跃（非终态）任务 |
| `get_task_stats()` | 任务统计（总数、成功率、耗时、分布） |
| `get_sub_tasks(parent_id)` | 获取并行子任务列表 |
| `get_task_logs(task_id, limit)` | 获取状态变更日志 |
| `get_workflow(name)` | 获取工作流定义 |
| `list_workflows()` | 列出所有已注册工作流 |

---

## 插件查询 API

`core/plugin` 模块提供查询已注册插件扩展的接口：

| 函数 | 返回类型 | 用途 |
|------|----------|------|
| `get_notify_backend(type)` | `Callable \| None` | 查询指定类型的通知后端 |
| `get_all_notify_backend_types()` | `set[str]` | 所有插件注册的通知类型名 |
| `get_cli_commands()` | `list` | 所有插件注册的 CLI 命令 |
| `get_global_hooks(name)` | `list[Callable]` | 指定名称的全局钩子列表 |

---

## 测试插件

### 单元测试

使用 `_reset()` 在测试间隔离插件状态（框架的 `tests/conftest.py` 已包含 autouse fixture）：

```python
from core.plugin import _register_plugin, _reset, get_notify_backend
from types import SimpleNamespace
from unittest.mock import MagicMock

def test_my_backend():
    handler = MagicMock()
    module = SimpleNamespace(notify_backends={"openclaw": handler})
    _register_plugin("test", module)

    assert get_notify_backend("openclaw") is handler

    # _reset() 会在每个测试后自动调用（autouse fixture）
```

### 集成测试

安装插件后验证发现机制：

```python
from core.plugin import discover, get_all_notify_backend_types

discover()
assert "openclaw" in get_all_notify_backend_types()
```

---

## 注意事项

- **幂等发现**：`discover()` 多次调用只执行一次扫描，`_reset()` 后可重新发现
- **失败隔离**：单个插件加载失败只记 warning 日志，不影响框架和其他插件
- **钩子名白名单**：`global_hooks` 的 key 必须是 `before_phase`、`after_phase`、`on_phase_error`，其他名称会被忽略
- **鸭子类型**：框架通过 `getattr` 提取扩展属性，不要求继承基类或实现 Protocol
- **Python 兼容性**：`importlib.metadata.entry_points` 兼容 Python 3.10+（与框架要求一致）
- **环境变量展开**：框架不会自动为插件后端展开 `${VAR}`，需插件自行调用 `expand_env_vars()`
