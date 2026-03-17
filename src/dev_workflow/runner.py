"""
Runner：阶段编排引擎（push 模型核心）
阶段函数已迁移到 workflows/ 下各模块，runner 只负责：
- execute_phase()：从注册表查阶段配置和函数并执行
- run_in_background()：非阻塞启动下一阶段
"""
from __future__ import annotations

import subprocess, sys
from pathlib import Path

from dev_workflow.db import get_task, get_conn, now
from dev_workflow.state_machine import transition, InvalidTransitionError
from dev_workflow.logger import get_logger, add_task_log_handler, remove_task_log_handler, set_phase, reset_phase

# 从 infra 重新导出常用符号（向后兼容 bin/ 脚本的 import）
from dev_workflow.infra import (  # noqa: F401
    _run_git, run_claude, notify, fetch_req, get_task_dir,
    acquire_lock, release_lock, is_locked,
    PROMPTS_DIR, DEVTASKS_DIR, PROJECTS_DIR,
    REQGENIE_BASE_URL, REQGENIE_MCP_URL, REQGENIE_REQ_URL,
    DEFAULT_NOTIFY_CHANNEL, DEFAULT_NOTIFY_TARGET,
    TIMEOUT_DESIGN, TIMEOUT_REVIEW, TIMEOUT_DEV, TIMEOUT_CODE_REVIEW, TIMEOUT_PR_DESC,
    REVIEW_RESULT_PASS, REVIEW_RESULT_REJECT,
)

log = get_logger()


# ──────────────────────────────────────────────────────────
# 后台启动（push 模型的核心）
# ──────────────────────────────────────────────────────────

def run_in_background(task_id: str, phase: str) -> None:
    """在后台子进程中运行下一阶段（非阻塞）"""
    script = Path(__file__).parent.parent.parent / 'bin' / 'run_phase.py'
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
    workflow_name = task.get('workflow', 'dev')

    # 确保工作流已注册
    from dev_workflow import registry
    if not registry.get_workflow(workflow_name):
        import dev_workflow.workflows  # noqa: F401 — 触发自动发现

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
            log.error('未知阶段：%s（工作流：%s）', phase, task.get('workflow', 'dev'))
            return

        current_status = task['status']
        trigger = config.get('trigger') if config else None
        running_state = config.get('running') if config else None

        # 获取转换表用于判断是否已被推进
        workflow_name = task.get('workflow', 'dev')
        from dev_workflow import registry
        transitions = registry.build_transitions(workflow_name)

        # 检查任务是否已被其他进程推进到后续状态（防止重复执行）
        if trigger and current_status != running_state:
            expected_from = [s for s, trs in transitions.items()
                            if any(t == trigger for t, _ in trs)]
            if current_status not in expected_from and current_status != running_state:
                log.info('任务已被推进到 %s，跳过 %s', current_status, phase)
                return

        log.info('========== 开始 ==========')

        # 如果已经是 running 状态（watcher 重试时），跳过 trigger，直接执行
        if running_state and current_status == running_state:
            log.info('已在 %s，跳过 trigger 直接执行', running_state)
        elif trigger:
            log.info('触发状态转换：%s', trigger)
            transition(task_id, trigger)

        phase_func(task_id)
        log.info('========== 完成 ==========')

    except InvalidTransitionError as e:
        log.warning('状态转换失败：%s', e)
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
    finally:
        reset_phase()
        remove_task_log_handler(log)
        release_lock(task_id)


def _set_phase_label(task_id: str, phase: str) -> None:
    """设置阶段日志标签，优先使用工作流定义中的 label"""
    task = get_task(task_id)
    if task:
        workflow_name = task.get('workflow', 'dev')
        from dev_workflow import registry
        phase_def = registry.get_phase(workflow_name, phase)
        if phase_def and phase_def.get('label'):
            from dev_workflow.logger import _phase_filter
            _phase_filter.phase_tag = phase_def['label']
            return
    set_phase(phase)
