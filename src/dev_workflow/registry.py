"""
工作流注册表：发现、注册、查询工作流定义，自动构建状态转换表
"""
from __future__ import annotations

import importlib
import pkgutil
from typing import Any

from dev_workflow.logger import get_logger

log = get_logger()

# 全局注册表：{workflow_name: module}
_registry: dict[str, Any] = {}


def discover() -> None:
    """扫描 workflows/ 目录，导入所有含 WORKFLOW 的模块并注册"""
    import dev_workflow.workflows as pkg
    for importer, mod_name, is_pkg in pkgutil.iter_modules(pkg.__path__):
        if is_pkg:
            continue
        full_name = f'dev_workflow.workflows.{mod_name}'
        try:
            mod = importlib.import_module(full_name)
            if hasattr(mod, 'WORKFLOW'):
                name = mod.WORKFLOW['name']
                _registry[name] = mod
                log.debug('注册工作流：%s（来自 %s）', name, full_name)
        except Exception as e:
            log.warning('加载工作流模块 %s 失败：%s', full_name, e)


def register(module: Any) -> None:
    """手动注册一个工作流模块"""
    name = module.WORKFLOW['name']
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
        {'name': mod.WORKFLOW['name'], 'description': mod.WORKFLOW.get('description', '')}
        for mod in _registry.values()
    ]


def get_phase(workflow_name: str, phase_name: str) -> dict | None:
    """获取指定工作流的阶段定义"""
    wf = get_workflow(workflow_name)
    if not wf:
        return None
    for phase in wf['phases']:
        if phase['name'] == phase_name:
            return phase
    return None


def get_phase_func(workflow_name: str, phase_name: str):
    """获取阶段的执行函数"""
    mod = _registry.get(workflow_name)
    if not mod:
        return None
    wf = mod.WORKFLOW
    for phase in wf['phases']:
        if phase['name'] == phase_name:
            return phase.get('func')
    return None


def get_next_phase(workflow_name: str, current_phase: str) -> str | None:
    """获取下一阶段名称（按 phases 列表顺序）"""
    wf = get_workflow(workflow_name)
    if not wf:
        return None
    phases = wf['phases']
    for i, phase in enumerate(phases):
        if phase['name'] == current_phase and i + 1 < len(phases):
            return phases[i + 1]['name']
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
    if 'transitions' in wf:
        return wf['transitions']

    phases = wf['phases']
    terminal_states = set(wf.get('terminal_states', ['cancelled']))
    transitions: dict[str, list[tuple[str, str]]] = {}

    for i, phase in enumerate(phases):
        pending = phase['pending_state']
        running = phase['running_state']
        trigger = phase['trigger']

        # pending → running
        transitions.setdefault(pending, []).append((trigger, running))

        # running → 下一阶段的 pending 或终态
        complete_trigger = phase.get('complete_trigger')
        if complete_trigger:
            if i + 1 < len(phases):
                next_pending = phases[i + 1]['pending_state']
                transitions.setdefault(running, []).append((complete_trigger, next_pending))
            else:
                # 最后一个阶段，转换到第一个终态（非 cancelled）
                done_state = next(
                    (s for s in wf.get('terminal_states', []) if s != 'cancelled'),
                    'completed'
                )
                transitions.setdefault(running, []).append((complete_trigger, done_state))

        # fail_trigger：running → pending（重试）
        fail_trigger = phase.get('fail_trigger')
        if fail_trigger:
            transitions.setdefault(running, []).append((fail_trigger, pending))

        # reject_trigger：running → rejected 状态
        reject_trigger = phase.get('reject_trigger')
        if reject_trigger:
            rejected_state = f'{phase["name"]}_rejected'
            transitions.setdefault(running, []).append((reject_trigger, rejected_state))

            # retry_target：rejected → 目标阶段的 pending
            retry_target = phase.get('retry_target')
            if retry_target:
                target_phase = next((p for p in phases if p['name'] == retry_target), None)
                if target_phase:
                    retry_trigger = f'retry_{retry_target}'
                    transitions.setdefault(rejected_state, []).append(
                        (retry_trigger, target_phase['pending_state'])
                    )

    # 所有非终态加 cancel 转换
    for state in list(transitions.keys()):
        if state not in terminal_states:
            existing_triggers = {t for t, _ in transitions[state]}
            if 'cancel' not in existing_triggers:
                transitions[state].append(('cancel', 'cancelled'))

    # rejected 状态也加 cancel
    for phase in phases:
        if phase.get('reject_trigger'):
            rejected_state = f'{phase["name"]}_rejected'
            if rejected_state in transitions:
                existing_triggers = {t for t, _ in transitions[rejected_state]}
                if 'cancel' not in existing_triggers:
                    transitions[rejected_state].append(('cancel', 'cancelled'))

    return transitions


def get_running_state_phase(workflow_name: str) -> dict[str, str]:
    """获取 running_state → phase_name 映射"""
    wf = get_workflow(workflow_name)
    if not wf:
        return {}
    return {phase['running_state']: phase['name'] for phase in wf['phases']}


def get_pending_state_phase(workflow_name: str) -> dict[str, str]:
    """获取 pending_state → phase_name 映射"""
    wf = get_workflow(workflow_name)
    if not wf:
        return {}
    return {phase['pending_state']: phase['name'] for phase in wf['phases']}


def get_all_states(workflow_name: str) -> list[str]:
    """获取工作流的所有状态"""
    wf = get_workflow(workflow_name)
    if not wf:
        return []
    states = []
    for phase in wf['phases']:
        states.append(phase['pending_state'])
        states.append(phase['running_state'])
        if phase.get('reject_trigger'):
            states.append(f'{phase["name"]}_rejected')
    states.extend(wf.get('terminal_states', ['cancelled']))
    return states


def get_terminal_states(workflow_name: str) -> list[str]:
    """获取工作流的终态列表"""
    wf = get_workflow(workflow_name)
    if not wf:
        return ['cancelled']
    return wf.get('terminal_states', ['cancelled'])
