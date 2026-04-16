"""工作流注册表：发现、注册、查询工作流定义，自动构建状态转换表
Workflow registry: discover, register, query workflow definitions, auto-build state transition tables.

支持 YAML 工作流定义（workflow.yaml + workflow.py 目录配对）
Supports YAML workflow definitions (workflow.yaml + workflow.py directory pairing)."""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from typing import Any

from core.logger import get_logger

log = get_logger()

# 全局注册表：{workflow_name: module} / Global registry: {workflow_name: module}
_registry: dict[str, Any] = {}


class WorkflowValidationError(Exception):
    """工作流定义校验失败
    Workflow definition validation failed."""

    pass


# ──────────────────────────────────────────────
# YAML 工作流加载
# YAML workflow loading
# ──────────────────────────────────────────────


class _YAMLWorkflowModule:
    """让 YAML 工作流对外表现和 Python 模块一致（都有 .WORKFLOW 属性）
    Make YAML workflows behave like Python modules (both have .WORKFLOW attribute)."""

    def __init__(self, workflow: dict):
        self.WORKFLOW = workflow


def _expand_phase_defaults(phase: dict, all_phase_names: set[str]) -> dict:
    """自动推导阶段的默认字段。
    Auto-derive default fields for a phase.

    推导规则（以 phase name 'design' 为例）：
    Derivation rules (using phase name 'design' as example):
      pending_state: pending_design
      running_state: running_design
      trigger: start_design
      complete_trigger: design_complete
      fail_trigger: design_fail
      label: DESIGN
      func name: run_design

    reject 语法糖 / reject syntactic sugar:
      reject: design → jump_trigger: {name}_reject, jump_target: design
    """
    name = phase["name"]
    expanded = dict(phase)

    expanded.setdefault("pending_state", f"pending_{name}")
    expanded.setdefault("running_state", f"running_{name}")
    expanded.setdefault("trigger", f"start_{name}")
    expanded.setdefault("complete_trigger", f"{name}_complete")
    expanded.setdefault("fail_trigger", f"{name}_fail")
    expanded.setdefault("label", name.upper())

    # reject 语法糖 → jump_trigger/jump_target + 标记来源
    # reject sugar → jump_trigger/jump_target + mark origin
    reject_target = expanded.pop("reject", None)
    if reject_target:
        expanded.setdefault("jump_trigger", f"{name}_reject")
        expanded.setdefault("jump_target", reject_target)
        expanded["_jump_origin"] = "reject"
        if reject_target not in all_phase_names:
            log.warning("阶段 %s 的 reject 目标 '%s' 不在 phases 中", name, reject_target)
        expanded.setdefault("max_rejections", 10)

    # 兼容旧字段: reject_trigger/retry_target → jump_trigger/jump_target
    # Legacy field compatibility: reject_trigger/retry_target → jump_trigger/jump_target
    legacy_reject_trigger = expanded.pop("reject_trigger", None)
    legacy_retry_target = expanded.pop("retry_target", None)
    if legacy_reject_trigger:
        expanded.setdefault("jump_trigger", legacy_reject_trigger)
    if legacy_retry_target:
        expanded.setdefault("jump_target", legacy_retry_target)

    return expanded


def _expand_parallel_defaults(parallel_def: dict, all_phase_names: set[str]) -> dict:
    """展开 parallel 块的子阶段默认值
    Expand default values for parallel block sub-phases."""
    expanded = dict(parallel_def)
    expanded.setdefault("fail_strategy", "cancel_all")

    sub_phases = []
    for sub in expanded.get("phases", []):
        sub_expanded = _expand_phase_defaults(sub, all_phase_names)
        sub_phases.append(sub_expanded)
    expanded["phases"] = sub_phases
    return expanded


def _load_yaml_workflow(wf_dir: Path) -> _YAMLWorkflowModule | None:
    """从工作流目录加载 YAML 工作流定义。
    Load YAML workflow definition from workflow directory.

    目录需包含 / Directory must contain:
      - workflow.yaml — 工作流结构定义 / Workflow structure definition
      - workflow.py   — 阶段函数实现 / Phase function implementations
    """
    import yaml

    yaml_path = wf_dir / "workflow.yaml"
    py_path = wf_dir / "workflow.py"

    if not yaml_path.exists():
        return None

    # 解析 YAML / Parse YAML
    with open(yaml_path, encoding="utf-8") as f:
        wf_def = yaml.safe_load(f)
    if not wf_def or not isinstance(wf_def, dict):
        log.warning("YAML 工作流 %s 为空或格式错误", yaml_path)
        return None

    # 导入同目录的 workflow.py 获取函数 / Import workflow.py from same directory to get functions
    py_module = None
    if py_path.exists():
        mod_name = f"autopilot_yaml_wf_{wf_dir.name}"
        try:
            if mod_name in sys.modules:
                py_module = sys.modules[mod_name]
            else:
                spec = importlib.util.spec_from_file_location(mod_name, py_path)
                if spec and spec.loader:
                    py_module = importlib.util.module_from_spec(spec)
                    sys.modules[mod_name] = py_module
                    spec.loader.exec_module(py_module)
        except Exception as e:
            log.warning("加载 YAML 工作流 Python 模块 %s 失败：%s", py_path, e)
            return None

    # 收集所有阶段名（用于 reject 目标校验）/ Collect all phase names (for reject target validation)
    all_phase_names: set[str] = set()
    for phase in wf_def.get("phases", []):
        if isinstance(phase, dict):
            if "parallel" in phase:
                par = phase["parallel"]
                for sub in par.get("phases", []):
                    if isinstance(sub, dict) and "name" in sub:
                        all_phase_names.add(sub["name"])
            elif "name" in phase:
                all_phase_names.add(phase["name"])

    # 展开阶段默认值并绑定函数 / Expand phase defaults and bind functions
    expanded_phases = []
    for phase in wf_def.get("phases", []):
        if not isinstance(phase, dict):
            continue

        if "parallel" in phase:
            # parallel 块 / Parallel block
            par = phase["parallel"]
            par_expanded = _expand_parallel_defaults(par, all_phase_names)
            # 绑定子阶段函数 / Bind sub-phase functions
            for sub in par_expanded.get("phases", []):
                _bind_phase_func(sub, py_module)
            expanded_phases.append({"parallel": par_expanded})
        else:
            phase_expanded = _expand_phase_defaults(phase, all_phase_names)
            _bind_phase_func(phase_expanded, py_module)
            expanded_phases.append(phase_expanded)

    wf_def["phases"] = expanded_phases

    # 自动推导 workflow 级别默认值 / Auto-derive workflow-level defaults
    if expanded_phases:
        first = expanded_phases[0]
        if "parallel" not in first:
            wf_def.setdefault("initial_state", first["pending_state"])
        else:
            # 如果第一个是 parallel，用并行组名 / If first is parallel, use parallel group name
            par_name = first["parallel"]["name"]
            wf_def.setdefault("initial_state", f"pending_{par_name}")
    wf_def.setdefault("terminal_states", ["done", "cancelled"])

    # 绑定 workflow 级别函数 / Bind workflow-level functions
    _bind_workflow_funcs(wf_def, py_module)

    # 转换 YAML 中的 transitions 格式（列表 → 元组）/ Convert YAML transitions format (list → tuple)
    if "transitions" in wf_def:
        wf_def["transitions"] = _normalize_transitions(wf_def["transitions"])

    return _YAMLWorkflowModule(wf_def)


def _normalize_transitions(transitions: dict) -> dict[str, list[tuple[str, str]]]:
    """将 YAML 中的 transitions 格式统一为 {state: [(trigger, target), ...]}
    Normalize YAML transitions format to {state: [(trigger, target), ...]}."""
    normalized: dict[str, list[tuple[str, str]]] = {}
    for state, trans_list in transitions.items():
        if not isinstance(trans_list, list):
            continue
        tuples = []
        for item in trans_list:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                tuples.append((str(item[0]), str(item[1])))
        normalized[state] = tuples
    return normalized


def _bind_phase_func(phase: dict, py_module: Any) -> None:
    """将阶段的 func 字符串绑定到 Python callable
    Bind phase func string to Python callable."""
    func_name = phase.get("func")
    if callable(func_name):
        return  # 已经是 callable / Already callable

    if func_name is None:
        # 自动约定：run_{phase_name} / Auto convention: run_{phase_name}
        func_name = f"run_{phase['name']}"

    if isinstance(func_name, str):
        if py_module and hasattr(py_module, func_name):
            phase["func"] = getattr(py_module, func_name)
        else:
            log.warning("找不到阶段函数 %s", func_name)
            # 设为占位 noop，避免校验失败 / Set to noop placeholder to avoid validation failure
            phase["func"] = lambda task_id: None


def _bind_workflow_funcs(wf_def: dict, py_module: Any) -> None:
    """绑定 workflow 级别的函数引用（setup_func, notify_func, hooks）
    Bind workflow-level function references (setup_func, notify_func, hooks)."""
    for key in ("setup_func", "notify_func"):
        func_ref = wf_def.get(key)
        if isinstance(func_ref, str) and py_module:
            if hasattr(py_module, func_ref):
                wf_def[key] = getattr(py_module, func_ref)
            else:
                log.warning("找不到工作流函数 %s.%s", key, func_ref)
                del wf_def[key]

    hooks = wf_def.get("hooks")
    if isinstance(hooks, dict) and py_module:
        for hook_name, func_ref in list(hooks.items()):
            if isinstance(func_ref, str):
                if hasattr(py_module, func_ref):
                    hooks[hook_name] = getattr(py_module, func_ref)
                else:
                    log.warning("找不到钩子函数 hooks.%s = %s", hook_name, func_ref)
                    del hooks[hook_name]


# ──────────────────────────────────────────────
# 校验
# Validation
# ──────────────────────────────────────────────


def validate_workflow(wf: dict) -> list[str]:
    """校验 WORKFLOW 字典，返回警告列表，严重错误直接 raise WorkflowValidationError
    Validate WORKFLOW dict, return warnings list; raise WorkflowValidationError on critical errors."""
    warnings: list[str] = []

    # ── 必须字段 / Required fields ──
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

    # ── phase 校验 / Phase validation ──
    phase_names: set[str] = set()
    all_phase_names = set()
    for p in wf["phases"]:
        if isinstance(p, dict):
            if "parallel" in p:
                par = p["parallel"]
                for sub in par.get("phases", []):
                    if isinstance(sub, dict) and "name" in sub:
                        all_phase_names.add(sub["name"])
            elif "name" in p:
                all_phase_names.add(p["name"])

    for i, phase in enumerate(wf["phases"]):
        if not isinstance(phase, dict):
            raise WorkflowValidationError(f"phases[{i}] 必须是 dict")

        # parallel 块校验 / Parallel block validation
        if "parallel" in phase:
            par = phase["parallel"]
            if not isinstance(par, dict):
                raise WorkflowValidationError(f"phases[{i}].parallel 必须是 dict")
            if "name" not in par:
                raise WorkflowValidationError(f"phases[{i}].parallel 缺少 name 字段")
            par_name = par["name"]
            if par_name in phase_names:
                raise WorkflowValidationError(f"重复的阶段名：{par_name}")
            phase_names.add(par_name)
            for j, sub in enumerate(par.get("phases", [])):
                if not isinstance(sub, dict):
                    raise WorkflowValidationError(f"phases[{i}].parallel.phases[{j}] 必须是 dict")
                if "name" not in sub:
                    raise WorkflowValidationError(f"phases[{i}].parallel.phases[{j}] 缺少 name 字段")
                sub_name = sub["name"]
                if sub_name in phase_names:
                    raise WorkflowValidationError(f"重复的阶段名：{sub_name}")
                phase_names.add(sub_name)
                _validate_regular_phase(sub, j, f"phases[{i}].parallel.", all_phase_names, warnings)
            continue

        # 普通阶段校验 / Regular phase validation
        _validate_regular_phase(phase, i, "", all_phase_names, warnings)
        if phase["name"] in phase_names:
            raise WorkflowValidationError(f"重复的阶段名：{phase['name']}")
        phase_names.add(phase["name"])

    # ── reject 语法糖方向校验：目标必须在当前阶段之前 ──
    # ── reject sugar direction validation: target must precede current phase ──
    ordered_names = []
    for p in wf["phases"]:
        if "parallel" in p:
            ordered_names.append(("parallel", p["parallel"]["name"], p["parallel"]))
        else:
            ordered_names.append(("phase", p["name"], p))

    for idx, (kind, name, obj) in enumerate(ordered_names):
        phases_to_check = []
        if kind == "parallel":
            phases_to_check = obj.get("phases", [])
        else:
            phases_to_check = [obj]

        for phase in phases_to_check:
            if phase.get("_jump_origin") != "reject":
                continue
            target = phase["jump_target"]
            target_idx = next((i for i, (_, n, _) in enumerate(ordered_names) if n == target), None)
            if target_idx is not None and target_idx >= idx:
                raise WorkflowValidationError(f'阶段 {phase["name"]} 的 reject 目标 "{target}" 必须在当前阶段之前')

    # ── 转换表完整性 / Transition table completeness ──
    if "transitions" in wf:
        if wf["initial_state"] not in wf["transitions"]:
            warnings.append(f'initial_state "{wf["initial_state"]}" 不在 transitions 中')
    else:
        first_phase = wf["phases"][0]
        if "parallel" in first_phase:
            pass  # parallel first phase 不检查 / Don't check parallel first phase
        else:
            first_pending = first_phase["pending_state"]
            if wf["initial_state"] != first_pending:
                warnings.append(f'initial_state "{wf["initial_state"]}" != phases[0].pending_state "{first_pending}"')

    # ── 可选字段类型检查 / Optional field type checks ──
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


def _validate_regular_phase(phase: dict, idx: int, prefix: str, all_phase_names: set[str], warnings: list[str]) -> None:
    """校验普通阶段（非 parallel）
    Validate regular phase (non-parallel)."""
    for pf in ("name", "pending_state", "running_state"):
        if pf not in phase:
            raise WorkflowValidationError(f"{prefix}phases[{idx}] 缺少必须字段：{pf}")
        if not isinstance(phase[pf], str):
            raise WorkflowValidationError(f"{prefix}phases[{idx}].{pf} 必须是 str")
    if "func" not in phase:
        raise WorkflowValidationError(f"{prefix}phases[{idx}] 缺少必须字段：func")
    if not callable(phase["func"]):
        raise WorkflowValidationError(f"{prefix}phases[{idx}].func 必须是 callable")

    # jump_trigger 必须配套 jump_target / jump_trigger must have matching jump_target
    if phase.get("jump_trigger") and not phase.get("jump_target"):
        warnings.append(f"阶段 {phase['name']} 有 jump_trigger 但无 jump_target")

    # jump_target 目标阶段必须存在 / jump_target target phase must exist
    if phase.get("jump_target"):
        target = phase["jump_target"]
        if target not in all_phase_names:
            raise WorkflowValidationError(f'阶段 {phase["name"]} 的 jump_target "{target}" 不在 phases 中')


# ──────────────────────────────────────────────
# 发现与注册
# Discovery and registration
# ──────────────────────────────────────────────


def discover() -> None:
    """扫描用户工作流目录，导入所有含 WORKFLOW 的模块并注册
    Scan user workflow directory, import all modules with WORKFLOW and register."""
    _discover_user()


def _discover_user() -> None:
    """扫描 AUTOPILOT_HOME/workflows/ 用户工作流
    Scan AUTOPILOT_HOME/workflows/ for user workflows."""
    from core import AUTOPILOT_HOME

    user_wf_dir = AUTOPILOT_HOME / "workflows"
    if not user_wf_dir.is_dir():
        return

    # 1. 扫描 *.py 文件（单文件 Python 工作流）/ Scan *.py files (single-file Python workflows)
    for py_file in sorted(user_wf_dir.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        mod_name = f"autopilot_user_wf_{py_file.stem}"
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

    # 2. 扫描子目录（YAML 工作流：workflow.yaml + workflow.py）
    #    Scan subdirectories (YAML workflows: workflow.yaml + workflow.py)
    for sub_dir in sorted(user_wf_dir.iterdir()):
        if not sub_dir.is_dir():
            continue
        if sub_dir.name.startswith("_"):
            continue
        yaml_path = sub_dir / "workflow.yaml"
        if not yaml_path.exists():
            continue
        try:
            mod = _load_yaml_workflow(sub_dir)
            if mod is None:
                continue
            try:
                warns = validate_workflow(mod.WORKFLOW)
                for w in warns:
                    log.warning("YAML 工作流 %s 校验警告：%s", sub_dir, w)
            except WorkflowValidationError as e:
                log.warning("YAML 工作流 %s 校验失败，跳过注册：%s", sub_dir, e)
                continue
            name = mod.WORKFLOW["name"]
            if name in _registry:
                log.info("YAML 工作流覆盖已注册：%s（来自 %s）", name, sub_dir)
            _registry[name] = mod
            log.debug("注册 YAML 工作流：%s（来自 %s）", name, sub_dir)
        except Exception as e:
            log.warning("加载 YAML 工作流 %s 失败：%s", sub_dir, e)


def register(module: Any) -> None:
    """手动注册一个工作流模块（校验失败直接 raise）
    Manually register a workflow module (raises on validation failure)."""
    validate_workflow(module.WORKFLOW)
    name = module.WORKFLOW["name"]
    _registry[name] = module


def load_yaml_workflow(wf_dir: Path) -> _YAMLWorkflowModule | None:
    """公开接口：从目录加载 YAML 工作流（用于外部调用和测试）
    Public interface: load YAML workflow from directory (for external use and testing)."""
    return _load_yaml_workflow(wf_dir)


# ──────────────────────────────────────────────
# 查询
# Query
# ──────────────────────────────────────────────


def get_workflow(name: str) -> dict | None:
    """获取工作流定义字典
    Get workflow definition dict."""
    if not (mod := _registry.get(name)):
        return None
    wf = getattr(mod, "WORKFLOW", None)
    return wf if isinstance(wf, dict) else None


def get_workflow_module(name: str) -> Any | None:
    """获取工作流模块
    Get workflow module."""
    return _registry.get(name)


def list_workflows() -> list[dict]:
    """列出所有已注册工作流
    List all registered workflows."""
    return [
        {"name": mod.WORKFLOW["name"], "description": mod.WORKFLOW.get("description", "")} for mod in _registry.values()
    ]


def get_phase(workflow_name: str, phase_name: str) -> dict | None:
    """获取指定工作流的阶段定义（支持 parallel 子阶段查找）
    Get phase definition for specified workflow (supports parallel sub-phase lookup)."""
    wf = get_workflow(workflow_name)
    if not wf:
        return None
    for phase in wf["phases"]:
        if "parallel" in phase:
            par = phase["parallel"]
            for sub in par.get("phases", []):
                if sub["name"] == phase_name:
                    return sub
        elif phase["name"] == phase_name:
            return phase
    return None


def get_phase_func(workflow_name: str, phase_name: str):
    """获取阶段的执行函数
    Get phase execution function."""
    mod = _registry.get(workflow_name)
    if not mod:
        return None
    wf = mod.WORKFLOW
    for phase in wf["phases"]:
        if "parallel" in phase:
            for sub in phase["parallel"].get("phases", []):
                if sub["name"] == phase_name:
                    return sub.get("func")
        elif phase["name"] == phase_name:
            return phase.get("func")
    return None


def get_next_phase(workflow_name: str, current_phase: str) -> str | None:
    """获取下一阶段名称（按 phases 列表顺序，跳过 parallel 块内部）
    Get next phase name (by phases list order, skipping parallel block internals)."""
    wf = get_workflow(workflow_name)
    if not wf:
        return None
    phases = wf["phases"]
    for i, phase in enumerate(phases):
        name = phase["parallel"]["name"] if "parallel" in phase else phase["name"]
        if name == current_phase and i + 1 < len(phases):
            next_phase = phases[i + 1]
            return next_phase["parallel"]["name"] if "parallel" in next_phase else next_phase["name"]
        # 也检查 parallel 子阶段名 / Also check parallel sub-phase names
        if "parallel" in phase:
            for sub in phase["parallel"].get("phases", []):
                if sub["name"] == current_phase:
                    # 子阶段的下一阶段是 parallel 块之后的阶段
                    # Next phase after sub-phase is the phase after the parallel block
                    if i + 1 < len(phases):
                        next_phase = phases[i + 1]
                        return next_phase["parallel"]["name"] if "parallel" in next_phase else next_phase["name"]
                    return None
    return None


def get_parallel_def(workflow_name: str, group_name: str) -> dict | None:
    """获取并行组定义
    Get parallel group definition."""
    wf = get_workflow(workflow_name)
    if not wf:
        return None
    for phase in wf["phases"]:
        if "parallel" in phase and phase["parallel"]["name"] == group_name:
            return phase["parallel"]
    return None


# ──────────────────────────────────────────────
# 转换表构建
# Transition table building
# ──────────────────────────────────────────────


def build_transitions(workflow_name: str) -> dict[str, list[tuple[str, str]]]:
    """构建状态转换表。
    Build state transition table.

    如果 WORKFLOW 有 'transitions' 字段直接用，否则从 phases 自动生成。
    If WORKFLOW has 'transitions' field, use it directly; otherwise auto-generate from phases.

    自动生成规则 / Auto-generation rules:
    - 每个阶段的 pending_state 可以通过 trigger 转换到 running_state
      Each phase's pending_state can transition to running_state via trigger
    - running_state 可以通过 complete_trigger 转换到下一阶段的 pending_state（或终态）
      running_state can transition to next phase's pending_state (or terminal state) via complete_trigger
    - 如果有 fail_trigger，running_state 可以回退到 pending_state
      If fail_trigger exists, running_state can rollback to pending_state
    - 如果有 jump_trigger + jump_target，生成驳回和重试转换
      If jump_trigger + jump_target exist, generate reject and retry transitions
    - parallel 阶段生成 fork/join 转换
      Parallel phases generate fork/join transitions
    - 所有非终态都可以通过 'cancel' 转换到 'cancelled'
      All non-terminal states can transition to 'cancelled' via 'cancel'
    """
    wf = get_workflow(workflow_name)
    if not wf:
        return {}

    # 如果工作流自定义了转换表，直接使用 / If workflow defines custom transitions, use directly
    if "transitions" in wf:
        return wf["transitions"]

    phases = wf["phases"]
    terminal_states = set(wf.get("terminal_states", ["cancelled"]))
    transitions: dict[str, list[tuple[str, str]]] = {}

    # 收集所有普通阶段（用于 jump_target 查找）/ Collect all regular phases (for jump_target lookup)
    all_flat_phases = []
    for phase in phases:
        if "parallel" in phase:
            for sub in phase["parallel"].get("phases", []):
                all_flat_phases.append(sub)
        else:
            all_flat_phases.append(phase)

    def _get_next_pending(idx: int) -> str | None:
        """获取 phases[idx] 之后的下一个 pending_state
        Get the next pending_state after phases[idx]."""
        if idx + 1 < len(phases):
            next_p = phases[idx + 1]
            if "parallel" in next_p:
                par_name = next_p["parallel"]["name"]
                return f"pending_{par_name}"
            return next_p["pending_state"]
        return None

    for i, phase in enumerate(phases):
        if "parallel" in phase:
            _build_parallel_transitions(phase["parallel"], i, phases, terminal_states, transitions, all_flat_phases)
            continue

        pending = phase["pending_state"]
        running = phase["running_state"]
        trigger = phase.get("trigger")

        # pending → running
        if trigger:
            transitions.setdefault(pending, []).append((trigger, running))

        # running → 下一阶段的 pending 或终态 / running → next phase's pending or terminal state
        complete_trigger = phase.get("complete_trigger")
        if complete_trigger:
            next_pending = _get_next_pending(i)
            if next_pending:
                transitions.setdefault(running, []).append((complete_trigger, next_pending))
            else:
                done_state = next((s for s in wf.get("terminal_states", []) if s != "cancelled"), "completed")
                transitions.setdefault(running, []).append((complete_trigger, done_state))

        # fail_trigger：running → pending（重试）/ fail_trigger: running → pending (retry)
        fail_trigger = phase.get("fail_trigger")
        if fail_trigger:
            transitions.setdefault(running, []).append((fail_trigger, pending))

        # jump_trigger：running → rejected 状态（或直接跳转）
        # jump_trigger: running → rejected state (or direct jump)
        jump_trigger = phase.get("jump_trigger")
        if jump_trigger:
            rejected_state = f"{phase['name']}_rejected"
            transitions.setdefault(running, []).append((jump_trigger, rejected_state))

            # jump_target：rejected → 目标阶段的 pending
            # jump_target: rejected → target phase's pending
            jump_target = phase.get("jump_target")
            if jump_target:
                target_phase = next((p for p in all_flat_phases if p["name"] == jump_target), None)
                if target_phase:
                    retry_trigger = f"retry_{jump_target}"
                    transitions.setdefault(rejected_state, []).append((retry_trigger, target_phase["pending_state"]))

    # 所有非终态加 cancel 转换 / Add cancel transition to all non-terminal states
    for state in list(transitions.keys()):
        if state not in terminal_states:
            existing_triggers = {t for t, _ in transitions[state]}
            if "cancel" not in existing_triggers:
                transitions[state].append(("cancel", "cancelled"))

    # rejected 状态也加 cancel / Add cancel to rejected states too
    for phase in phases:
        if "parallel" in phase:
            for sub in phase["parallel"].get("phases", []):
                if sub.get("jump_trigger"):
                    rejected_state = f"{sub['name']}_rejected"
                    if rejected_state in transitions:
                        existing_triggers = {t for t, _ in transitions[rejected_state]}
                        if "cancel" not in existing_triggers:
                            transitions[rejected_state].append(("cancel", "cancelled"))
        else:
            if phase.get("jump_trigger"):
                rejected_state = f"{phase['name']}_rejected"
                if rejected_state in transitions:
                    existing_triggers = {t for t, _ in transitions[rejected_state]}
                    if "cancel" not in existing_triggers:
                        transitions[rejected_state].append(("cancel", "cancelled"))

    return transitions


def _build_parallel_transitions(
    parallel_def: dict,
    idx: int,
    all_phases: list,
    terminal_states: set,
    transitions: dict,
    all_flat_phases: list,
) -> None:
    """为并行组构建 fork/join 转换
    Build fork/join transitions for parallel group."""
    group_name = parallel_def["name"]
    pending_group = f"pending_{group_name}"
    waiting_group = f"waiting_{group_name}"
    fork_trigger = f"start_{group_name}"
    join_trigger = f"{group_name}_complete"

    # pending_group → waiting_group（fork）
    transitions.setdefault(pending_group, []).append((fork_trigger, waiting_group))

    # 子阶段各自的转换 / Individual sub-phase transitions
    for sub in parallel_def.get("phases", []):
        pending = sub["pending_state"]
        running = sub["running_state"]
        trigger = sub.get("trigger")

        if trigger:
            transitions.setdefault(pending, []).append((trigger, running))

        # 子阶段 complete：running → sub_complete 状态
        # Sub-phase complete: running → sub_complete state
        complete_trigger = sub.get("complete_trigger")
        if complete_trigger:
            sub_done = f"{sub['name']}_done"
            transitions.setdefault(running, []).append((complete_trigger, sub_done))

        fail_trigger = sub.get("fail_trigger")
        if fail_trigger:
            transitions.setdefault(running, []).append((fail_trigger, pending))

    # waiting_group → 下一阶段（join）/ waiting_group → next phase (join)
    if idx + 1 < len(all_phases):
        next_p = all_phases[idx + 1]
        if "parallel" in next_p:
            next_pending = f"pending_{next_p['parallel']['name']}"
        else:
            next_pending = next_p["pending_state"]
        transitions.setdefault(waiting_group, []).append((join_trigger, next_pending))
    else:
        # 最后一个阶段 / Last phase
        done_state = next((s for s in terminal_states if s != "cancelled"), "completed")
        transitions.setdefault(waiting_group, []).append((join_trigger, done_state))

    # fail trigger for parallel group
    fail_trigger = f"{group_name}_fail"
    transitions.setdefault(waiting_group, []).append((fail_trigger, pending_group))


# ──────────────────────────────────────────────
# 状态映射
# State mappings
# ──────────────────────────────────────────────


def get_running_state_phase(workflow_name: str) -> dict[str, str]:
    """获取 running_state → phase_name 映射
    Get running_state → phase_name mapping."""
    wf = get_workflow(workflow_name)
    if not wf:
        return {}
    result = {}
    for phase in wf["phases"]:
        if "parallel" in phase:
            for sub in phase["parallel"].get("phases", []):
                result[sub["running_state"]] = sub["name"]
        else:
            result[phase["running_state"]] = phase["name"]
    return result


def get_pending_state_phase(workflow_name: str) -> dict[str, str]:
    """获取 pending_state → phase_name 映射
    Get pending_state → phase_name mapping."""
    wf = get_workflow(workflow_name)
    if not wf:
        return {}
    result = {}
    for phase in wf["phases"]:
        if "parallel" in phase:
            par = phase["parallel"]
            # 并行组的 pending / Parallel group's pending
            result[f"pending_{par['name']}"] = par["name"]
            for sub in par.get("phases", []):
                result[sub["pending_state"]] = sub["name"]
        else:
            result[phase["pending_state"]] = phase["name"]
    return result


def get_all_states(workflow_name: str) -> list[str]:
    """获取工作流的所有状态
    Get all states of a workflow."""
    wf = get_workflow(workflow_name)
    if not wf:
        return []
    states = []
    for phase in wf["phases"]:
        if "parallel" in phase:
            par = phase["parallel"]
            states.append(f"pending_{par['name']}")
            states.append(f"waiting_{par['name']}")
            for sub in par.get("phases", []):
                states.append(sub["pending_state"])
                states.append(sub["running_state"])
                if sub.get("jump_trigger"):
                    states.append(f"{sub['name']}_rejected")
        else:
            states.append(phase["pending_state"])
            states.append(phase["running_state"])
            if phase.get("jump_trigger"):
                states.append(f"{phase['name']}_rejected")
    states.extend(wf.get("terminal_states", ["cancelled"]))
    return states


def get_terminal_states(workflow_name: str) -> list[str]:
    """获取工作流的终态列表
    Get list of terminal states for a workflow."""
    wf = get_workflow(workflow_name)
    if not wf:
        return ["cancelled"]
    return wf.get("terminal_states", ["cancelled"])


# ──────────────────────────────────────────────
# 重试策略
# Retry policy
# ──────────────────────────────────────────────

DEFAULT_RETRY_POLICY: dict = {
    "max_retries": 3,
    "backoff": "fixed",
    "delay": 60,
    "max_delay": 600,
    "stuck_timeout": 600,
}


def get_retry_policy(workflow_name: str, phase_name: str | None = None) -> dict:
    """获取重试策略：phase 级别 > workflow 级别 > DEFAULT_RETRY_POLICY
    Get retry policy: phase level > workflow level > DEFAULT_RETRY_POLICY."""
    policy = dict(DEFAULT_RETRY_POLICY)

    wf = get_workflow(workflow_name)
    if not wf:
        return policy

    # workflow 级别覆盖 / Workflow level override
    wf_policy = wf.get("retry_policy")
    if isinstance(wf_policy, dict):
        policy.update(wf_policy)

    # phase 级别覆盖 / Phase level override
    if phase_name:
        phase = get_phase(workflow_name, phase_name)
        if phase:
            phase_policy = phase.get("retry_policy")
            if isinstance(phase_policy, dict):
                policy.update(phase_policy)

    return policy
