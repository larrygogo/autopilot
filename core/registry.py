"""
工作流注册表：发现、注册、查询工作流定义，自动构建状态转换表
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from typing import Any

from core.logger import get_logger

log = get_logger()

# 全局注册表：{workflow_name: module}
_registry: dict[str, Any] = {}


class WorkflowValidationError(Exception):
    """工作流定义校验失败"""

    pass


def validate_workflow(wf: dict) -> list[str]:
    """校验 WORKFLOW 字典，返回警告列表，严重错误直接 raise WorkflowValidationError"""
    warnings: list[str] = []

    # ── 必须字段 ──
    required_fields = {
        "name": str,
        "phases": list,
        "initial_state": str,
        "terminal_states": list,
    }
    for field, expected_type in required_fields.items():
        if field not in wf:
            raise WorkflowValidationError(f"缺少必须字段：{field}")
        if not isinstance(wf[field], expected_type):
            actual = type(wf[field]).__name__
            raise WorkflowValidationError(f"字段 {field} 类型错误：期望 {expected_type.__name__}，得到 {actual}")

    if not wf["phases"]:
        raise WorkflowValidationError("phases 不能为空")
    if not wf["terminal_states"]:
        raise WorkflowValidationError("terminal_states 不能为空")

    # ── phase 校验 ──
    phase_names: set[str] = set()
    all_phase_names = {p["name"] for p in wf["phases"] if isinstance(p, dict) and "name" in p}
    for i, phase in enumerate(wf["phases"]):
        if not isinstance(phase, dict):
            raise WorkflowValidationError(f"phases[{i}] 必须是 dict")
        for pf in ("name", "pending_state", "running_state"):
            if pf not in phase:
                raise WorkflowValidationError(f"phases[{i}] 缺少必须字段：{pf}")
            if not isinstance(phase[pf], str):
                raise WorkflowValidationError(f"phases[{i}].{pf} 必须是 str")
        if "func" not in phase:
            raise WorkflowValidationError(f"phases[{i}] 缺少必须字段：func")
        if not callable(phase["func"]):
            raise WorkflowValidationError(f"phases[{i}].func 必须是 callable")

        # 阶段名唯一性
        if phase["name"] in phase_names:
            raise WorkflowValidationError(f"重复的阶段名：{phase['name']}")
        phase_names.add(phase["name"])

        # reject_trigger 必须配套 retry_target
        if phase.get("reject_trigger") and not phase.get("retry_target"):
            warnings.append(f"阶段 {phase['name']} 有 reject_trigger 但无 retry_target")

        # retry_target 目标阶段必须存在
        if phase.get("retry_target"):
            target = phase["retry_target"]
            if target not in all_phase_names:
                raise WorkflowValidationError(f'阶段 {phase["name"]} 的 retry_target "{target}" 不在 phases 中')

    # ── 转换表完整性 ──
    if "transitions" in wf:
        if wf["initial_state"] not in wf["transitions"]:
            warnings.append(f'initial_state "{wf["initial_state"]}" 不在 transitions 中')
    else:
        first_pending = wf["phases"][0]["pending_state"]
        if wf["initial_state"] != first_pending:
            warnings.append(f'initial_state "{wf["initial_state"]}" != phases[0].pending_state "{first_pending}"')

    # ── 可选字段类型检查 ──
    if "max_rejections" in wf and not isinstance(wf["max_rejections"], int):
        warnings.append("max_rejections 应为 int")
    if "hooks" in wf:
        if not isinstance(wf["hooks"], dict):
            warnings.append("hooks 应为 dict")
        else:
            valid_hook_names = {"before_phase", "after_phase", "on_phase_error"}
            for key, val in wf["hooks"].items():
                if key not in valid_hook_names:
                    warnings.append(f"hooks 包含未知钩子：{key}（允许：{valid_hook_names}）")
                if not callable(val):
                    warnings.append(f'hooks["{key}"] 必须是 callable')
    if "retry_policy" in wf and not isinstance(wf["retry_policy"], dict):
        warnings.append("retry_policy 应为 dict")

    return warnings


def discover() -> None:
    """扫描用户工作流目录，导入所有含 WORKFLOW 的模块并注册"""
    _discover_user()


def _discover_user() -> None:
    """扫描 AUTOPILOT_HOME/workflows/ 用户工作流"""
    from core import AUTOPILOT_HOME

    user_wf_dir = AUTOPILOT_HOME / "workflows"
    if not user_wf_dir.is_dir():
        return
    for py_file in sorted(user_wf_dir.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        mod_name = f"devpilot_user_wf_{py_file.stem}"
        try:
            if mod_name in sys.modules:
                mod = sys.modules[mod_name]
            else:
                spec = importlib.util.spec_from_file_location(mod_name, py_file)
                if spec is None or spec.loader is None:
                    continue
                mod = importlib.util.module_from_spec(spec)
                sys.modules[mod_name] = mod
                spec.loader.exec_module(mod)
            if hasattr(mod, "WORKFLOW"):
                try:
                    warns = validate_workflow(mod.WORKFLOW)
                    for w in warns:
                        log.warning("用户工作流 %s 校验警告：%s", py_file, w)
                except WorkflowValidationError as e:
                    log.warning("用户工作流 %s 校验失败，跳过注册：%s", py_file, e)
                    continue
                name = mod.WORKFLOW["name"]
                if name in _registry:
                    log.info("用户工作流覆盖已注册：%s（来自 %s）", name, py_file)
                _registry[name] = mod
                log.debug("注册用户工作流：%s（来自 %s）", name, py_file)
        except Exception as e:
            log.warning("加载用户工作流 %s 失败：%s", py_file, e)


def register(module: Any) -> None:
    """手动注册一个工作流模块（校验失败直接 raise）"""
    validate_workflow(module.WORKFLOW)
    name = module.WORKFLOW["name"]
    _registry[name] = module


def get_workflow(name: str) -> dict | None:
    """获取工作流定义字典"""
    mod = _registry.get(name)
    return mod.WORKFLOW if mod else None


def get_workflow_module(name: str) -> Any | None:
    """获取工作流模块"""
    return _registry.get(name)


def list_workflows() -> list[dict]:
    """列出所有已注册工作流"""
    return [
        {"name": mod.WORKFLOW["name"], "description": mod.WORKFLOW.get("description", "")} for mod in _registry.values()
    ]


def get_phase(workflow_name: str, phase_name: str) -> dict | None:
    """获取指定工作流的阶段定义"""
    wf = get_workflow(workflow_name)
    if not wf:
        return None
    for phase in wf["phases"]:
        if phase["name"] == phase_name:
            return phase
    return None


def get_phase_func(workflow_name: str, phase_name: str):
    """获取阶段的执行函数"""
    mod = _registry.get(workflow_name)
    if not mod:
        return None
    wf = mod.WORKFLOW
    for phase in wf["phases"]:
        if phase["name"] == phase_name:
            return phase.get("func")
    return None


def get_next_phase(workflow_name: str, current_phase: str) -> str | None:
    """获取下一阶段名称（按 phases 列表顺序）"""
    wf = get_workflow(workflow_name)
    if not wf:
        return None
    phases = wf["phases"]
    for i, phase in enumerate(phases):
        if phase["name"] == current_phase and i + 1 < len(phases):
            return phases[i + 1]["name"]
    return None


def build_transitions(workflow_name: str) -> dict[str, list[tuple[str, str]]]:
    """
    构建状态转换表。
    如果 WORKFLOW 有 'transitions' 字段直接用，否则从 phases 自动生成。

    自动生成规则：
    - 每个阶段的 pending_state 可以通过 trigger 转换到 running_state
    - running_state 可以通过 complete_trigger 转换到下一阶段的 pending_state（或终态）
    - 如果有 fail_trigger，running_state 可以回退到 pending_state
    - 如果有 reject_trigger + retry_target，生成驳回和重试转换
    - 所有非终态都可以通过 'cancel' 转换到 'cancelled'
    """
    wf = get_workflow(workflow_name)
    if not wf:
        return {}

    # 如果工作流自定义了转换表，直接使用
    if "transitions" in wf:
        return wf["transitions"]

    phases = wf["phases"]
    terminal_states = set(wf.get("terminal_states", ["cancelled"]))
    transitions: dict[str, list[tuple[str, str]]] = {}

    for i, phase in enumerate(phases):
        pending = phase["pending_state"]
        running = phase["running_state"]
        trigger = phase["trigger"]

        # pending → running
        transitions.setdefault(pending, []).append((trigger, running))

        # running → 下一阶段的 pending 或终态
        complete_trigger = phase.get("complete_trigger")
        if complete_trigger:
            if i + 1 < len(phases):
                next_pending = phases[i + 1]["pending_state"]
                transitions.setdefault(running, []).append((complete_trigger, next_pending))
            else:
                # 最后一个阶段，转换到第一个终态（非 cancelled）
                done_state = next((s for s in wf.get("terminal_states", []) if s != "cancelled"), "completed")
                transitions.setdefault(running, []).append((complete_trigger, done_state))

        # fail_trigger：running → pending（重试）
        fail_trigger = phase.get("fail_trigger")
        if fail_trigger:
            transitions.setdefault(running, []).append((fail_trigger, pending))

        # reject_trigger：running → rejected 状态
        reject_trigger = phase.get("reject_trigger")
        if reject_trigger:
            rejected_state = f"{phase['name']}_rejected"
            transitions.setdefault(running, []).append((reject_trigger, rejected_state))

            # retry_target：rejected → 目标阶段的 pending
            retry_target = phase.get("retry_target")
            if retry_target:
                target_phase = next((p for p in phases if p["name"] == retry_target), None)
                if target_phase:
                    retry_trigger = f"retry_{retry_target}"
                    transitions.setdefault(rejected_state, []).append((retry_trigger, target_phase["pending_state"]))

    # 所有非终态加 cancel 转换
    for state in list(transitions.keys()):
        if state not in terminal_states:
            existing_triggers = {t for t, _ in transitions[state]}
            if "cancel" not in existing_triggers:
                transitions[state].append(("cancel", "cancelled"))

    # rejected 状态也加 cancel
    for phase in phases:
        if phase.get("reject_trigger"):
            rejected_state = f"{phase['name']}_rejected"
            if rejected_state in transitions:
                existing_triggers = {t for t, _ in transitions[rejected_state]}
                if "cancel" not in existing_triggers:
                    transitions[rejected_state].append(("cancel", "cancelled"))

    return transitions


def get_running_state_phase(workflow_name: str) -> dict[str, str]:
    """获取 running_state → phase_name 映射"""
    wf = get_workflow(workflow_name)
    if not wf:
        return {}
    return {phase["running_state"]: phase["name"] for phase in wf["phases"]}


def get_pending_state_phase(workflow_name: str) -> dict[str, str]:
    """获取 pending_state → phase_name 映射"""
    wf = get_workflow(workflow_name)
    if not wf:
        return {}
    return {phase["pending_state"]: phase["name"] for phase in wf["phases"]}


def get_all_states(workflow_name: str) -> list[str]:
    """获取工作流的所有状态"""
    wf = get_workflow(workflow_name)
    if not wf:
        return []
    states = []
    for phase in wf["phases"]:
        states.append(phase["pending_state"])
        states.append(phase["running_state"])
        if phase.get("reject_trigger"):
            states.append(f"{phase['name']}_rejected")
    states.extend(wf.get("terminal_states", ["cancelled"]))
    return states


def get_terminal_states(workflow_name: str) -> list[str]:
    """获取工作流的终态列表"""
    wf = get_workflow(workflow_name)
    if not wf:
        return ["cancelled"]
    return wf.get("terminal_states", ["cancelled"])


# ──────────────────────────────────────────────────────────
# 重试策略
# ──────────────────────────────────────────────────────────

DEFAULT_RETRY_POLICY: dict = {
    "max_retries": 3,
    "backoff": "fixed",
    "delay": 60,
    "max_delay": 600,
    "stuck_timeout": 600,
}


def get_retry_policy(workflow_name: str, phase_name: str | None = None) -> dict:
    """获取重试策略：phase 级别 > workflow 级别 > DEFAULT_RETRY_POLICY"""
    policy = dict(DEFAULT_RETRY_POLICY)

    wf = get_workflow(workflow_name)
    if not wf:
        return policy

    # workflow 级别覆盖
    wf_policy = wf.get("retry_policy")
    if isinstance(wf_policy, dict):
        policy.update(wf_policy)

    # phase 级别覆盖
    if phase_name:
        for phase in wf.get("phases", []):
            if phase["name"] == phase_name:
                phase_policy = phase.get("retry_policy")
                if isinstance(phase_policy, dict):
                    policy.update(phase_policy)
                break

    return policy
