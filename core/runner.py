"""
Runner：阶段编排引擎（push 模型核心）
阶段函数已迁移到 workflows/ 下各模块，runner 只负责：
- execute_phase()：从注册表查阶段配置和函数并执行
- run_in_background()：非阻塞启动下一阶段
"""
from __future__ import annotations

import subprocess, sys
from pathlib import Path

from core.db import get_task, get_conn, now
from core.state_machine import transition, InvalidTransitionError
from core.infra import acquire_lock, release_lock, get_task_dir, notify
from core.logger import get_logger, add_task_log_handler, remove_task_log_handler, set_phase, reset_phase

log = get_logger()


# ──────────────────────────────────────────────────────────
# 后台启动（push 模型的核心）
# ──────────────────────────────────────────────────────────

def run_in_background(task_id: str, phase: str) -> None:
    """在后台子进程中运行下一阶段（非阻塞）"""
    script = Path(__file__).parent.parent / 'bin' / 'run_phase.py'
    subprocess.Popen(
        [sys.executable, str(script), task_id, phase],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


# ──────────────────────────────────────────────────────────
# 阶段执行引擎
# ──────────────────────────────────────────────────────────

def _get_phase_config_and_func(task: dict, phase: str):
    """从注册表查阶段配置和执行函数，fallback 到旧的硬编码映射"""
    workflow_name = task.get('workflow', '')

    # 确保工作流已注册
    from core import registry
    if not registry.get_workflow(workflow_name):
        import core.workflows  # noqa: F401 — 触发自动发现

    phase_def = registry.get_phase(workflow_name, phase)
    phase_func = registry.get_phase_func(workflow_name, phase)

    if phase_def and phase_func:
        return {
            'trigger': phase_def.get('trigger'),
            'running': phase_def.get('running_state'),
        }, phase_func

    # fallback：未找到注册的工作流（不应该发生，但保险起见）
    log.warning('未找到工作流 %s 的阶段 %s，尝试 fallback', workflow_name, phase)
    return None, None


def _invoke_hook(task: dict, hook_name: str, phase: str, error: Exception | None = None) -> None:
    """安全调用工作流钩子，异常只记日志不中断主流程"""
    workflow_name = task.get('workflow', '')
    try:
        from core import registry
        wf = registry.get_workflow(workflow_name)
        if not wf:
            return
        hooks = wf.get('hooks')
        if not hooks or not isinstance(hooks, dict):
            return
        hook_func = hooks.get(hook_name)
        if not hook_func or not callable(hook_func):
            return
        if hook_name == 'on_phase_error':
            hook_func(task['id'], phase, error)
        else:
            hook_func(task['id'], phase)
    except Exception as e:
        log.warning('钩子 %s 执行异常（不影响主流程）：%s', hook_name, e)


def execute_phase(task_id: str, phase: str) -> None:
    """执行指定阶段（带原子锁保护，防止双重状态转换）"""
    fd = acquire_lock(task_id)
    if fd is None:
        log.warning('已有进程在运行，跳过 %s', phase)
        return

    # 挂载任务级文件日志 + 设置阶段标签
    task_dir = get_task_dir(task_id)
    add_task_log_handler(log, task_dir)

    # 动态设置阶段标签（优先使用工作流定义中的 label）
    _set_phase_label(task_id, phase)

    try:
        task = get_task(task_id)
        if not task:
            log.error('任务不存在: %s', task_id)
            return

        config, phase_func = _get_phase_config_and_func(task, phase)
        if not phase_func:
            log.error('未知阶段：%s（工作流：%s）', phase, task.get('workflow', ''))
            return

        current_status = task['status']
        trigger = config.get('trigger') if config else None
        running_state = config.get('running') if config else None

        # 获取转换表用于判断是否已被推进
        workflow_name = task.get('workflow', '')
        from core import registry
        transitions = registry.build_transitions(workflow_name)

        # 检查任务是否已被其他进程推进到后续状态（防止重复执行）
        if trigger and current_status != running_state:
            expected_from = [s for s, trs in transitions.items()
                            if any(t == trigger for t, _ in trs)]
            if current_status not in expected_from and current_status != running_state:
                log.info('任务已被推进到 %s，跳过 %s', current_status, phase)
                return

        # before_phase 钩子
        _invoke_hook(task, 'before_phase', phase)

        log.info('========== 开始 ==========')

        # 如果已经是 running 状态（watcher 重试时），跳过 trigger，直接执行
        if running_state and current_status == running_state:
            log.info('已在 %s，跳过 trigger 直接执行', running_state)
        elif trigger:
            log.info('触发状态转换：%s', trigger)
            transition(task_id, trigger)

        phase_func(task_id)
        log.info('========== 完成 ==========')

        # after_phase 钩子
        task = get_task(task_id)  # 重新读取，phase_func 内部可能已转换状态
        if task:
            _invoke_hook(task, 'after_phase', phase)

    except InvalidTransitionError as e:
        log.warning('状态转换失败：%s', e)
        # on_phase_error 钩子
        task = get_task(task_id)
        if task:
            _invoke_hook(task, 'on_phase_error', phase, e)
    except Exception as e:
        log.error('执行失败：%s', e, exc_info=True)
        # 记录失败到数据库
        with get_conn() as conn:
            conn.execute('UPDATE tasks SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?',
                         (now(), task_id))
        # 立即通知用户
        try:
            task = get_task(task_id)
            if task:
                notify(task, f'⚠️ 阶段 {phase} 执行失败：《{task["title"]}》\n\n错误：{e}')
        except Exception:
            pass
        # on_phase_error 钩子
        task = get_task(task_id)
        if task:
            _invoke_hook(task, 'on_phase_error', phase, e)
    finally:
        reset_phase()
        remove_task_log_handler(log)
        release_lock(task_id)


def _set_phase_label(task_id: str, phase: str) -> None:
    """设置阶段日志标签，优先使用工作流定义中的 label"""
    task = get_task(task_id)
    if task:
        workflow_name = task.get('workflow', '')
        from core import registry
        phase_def = registry.get_phase(workflow_name, phase)
        if phase_def and phase_def.get('label'):
            from core.logger import _phase_filter
            _phase_filter.phase_tag = phase_def['label']
            return
    set_phase(phase)
