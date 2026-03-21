"""Runner：阶段编排引擎（push 模型核心）
Runner: phase orchestration engine (core of push model).

阶段函数已迁移到 workflows/ 下各模块，runner 只负责：
Phase functions have been moved to workflow modules; runner only handles:
- execute_phase()：从注册表查阶段配置和函数并执行
  Look up phase config and function from registry and execute
- run_in_background()：非阻塞启动下一阶段
  Non-blocking launch of next phase
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from core.db import get_conn, get_task, now
from core.infra import acquire_lock, get_task_dir, notify, release_lock
from core.logger import add_task_log_handler, get_logger, remove_task_log_handler, reset_phase, set_phase
from core.state_machine import InvalidTransitionError, transition

log = get_logger()


# ──────────────────────────────────────────────
# 后台启动（push 模型的核心）
# Background launch (core of push model)
# ──────────────────────────────────────────────


def run_in_background(task_id: str, phase: str) -> None:
    """在后台子进程中运行下一阶段（非阻塞），输出写入任务日志文件
    Run next phase in background subprocess (non-blocking), output written to task log file."""
    script = Path(__file__).parent.parent / "bin" / "run_phase.py"
    log_dir = get_task_dir(task_id)
    log_file = log_dir / "background.log"
    fd = None
    try:
        fd = open(log_file, "a", encoding="utf-8")
        subprocess.Popen(
            [sys.executable, str(script), task_id, phase],
            stdout=fd,
            stderr=fd,
            start_new_session=True,
        )
    except Exception as e:
        log.error("后台启动阶段 %s 失败：%s", phase, e, exc_info=True)
    finally:
        # 父进程关闭 fd；子进程已通过 start_new_session 独立运行，持有继承的文件描述符
        # Parent closes fd; subprocess runs independently via start_new_session with inherited fd
        if fd:
            try:
                fd.close()
            except Exception:
                pass


# ──────────────────────────────────────────────
# 阶段执行引擎
# Phase execution engine
# ──────────────────────────────────────────────


def _get_phase_config_and_func(task: dict, phase: str):
    """从注册表查阶段配置和执行函数
    Look up phase config and execution function from registry."""
    workflow_name = task.get("workflow", "")

    # 确保工作流已注册 / Ensure workflow is registered
    from core import registry

    if not registry.get_workflow(workflow_name):
        from core.registry import discover

        discover()

    phase_def = registry.get_phase(workflow_name, phase)
    phase_func = registry.get_phase_func(workflow_name, phase)

    if phase_def and phase_func:
        return {
            "trigger": phase_def.get("trigger"),
            "running": phase_def.get("running_state"),
        }, phase_func

    # fallback：未找到注册的工作流（不应该发生，但保险起见）
    # Fallback: workflow not found in registry (shouldn't happen, but just in case)
    log.warning("未找到工作流 %s 的阶段 %s，尝试 fallback", workflow_name, phase)
    return None, None


def _invoke_hook(task: dict, hook_name: str, phase: str, error: Exception | None = None) -> None:
    """安全调用工作流钩子，异常只记日志不中断主流程
    Safely invoke workflow hook; exceptions are logged without interrupting main flow."""
    workflow_name = task.get("workflow", "")
    try:
        from core import registry

        wf = registry.get_workflow(workflow_name)
        if not wf:
            return
        hooks = wf.get("hooks")
        if not hooks or not isinstance(hooks, dict):
            return
        hook_func = hooks.get(hook_name)
        if not hook_func or not callable(hook_func):
            return
        if hook_name == "on_phase_error":
            hook_func(task["id"], phase, error)
        else:
            hook_func(task["id"], phase)
    except Exception as e:
        log.warning("钩子 %s 执行异常（不影响主流程）：%s", hook_name, e)

    # 插件全局钩子（工作流级钩子之后执行）/ Plugin global hooks (executed after workflow-level hooks)
    from core.plugin import get_global_hooks

    for plugin_hook in get_global_hooks(hook_name):
        try:
            if hook_name == "on_phase_error":
                plugin_hook(task["id"], phase, error)
            else:
                plugin_hook(task["id"], phase)
        except Exception as e:
            log.warning("插件全局钩子 %s 执行异常：%s", hook_name, e)


def execute_phase(task_id: str, phase: str) -> None:
    """执行指定阶段（带原子锁保护，防止双重状态转换）
    Execute the specified phase with atomic lock protection to prevent duplicate transitions."""
    fd = acquire_lock(task_id)
    if fd is None:
        log.warning("已有进程在运行，跳过 %s", phase)
        return

    # 挂载任务级文件日志 + 设置阶段标签 / Attach task-level file log + set phase tag
    task_dir = get_task_dir(task_id)
    add_task_log_handler(log, task_dir)

    # 动态设置阶段标签（优先使用工作流定义中的 label）
    # Dynamically set phase tag (prefer label from workflow definition)
    _set_phase_label(task_id, phase)

    try:
        task = get_task(task_id)
        if not task:
            log.error("任务不存在: %s", task_id)
            return

        config, phase_func = _get_phase_config_and_func(task, phase)
        if not phase_func:
            log.error("未知阶段：%s（工作流：%s）", phase, task.get("workflow", ""))
            return

        current_status = task["status"]
        trigger = config.get("trigger") if config else None
        running_state = config.get("running") if config else None

        # 获取转换表用于判断是否已被推进 / Get transition table to check if already advanced
        workflow_name = task.get("workflow", "")
        from core import registry

        transitions = registry.build_transitions(workflow_name)

        # 检查任务是否已被其他进程推进到后续状态（防止重复执行）
        # Check if task was already advanced by another process (prevent duplicate execution)
        if trigger and current_status != running_state:
            expected_from = [s for s, trs in transitions.items() if any(t == trigger for t, _ in trs)]
            if current_status not in expected_from and current_status != running_state:
                log.info("任务已被推进到 %s，跳过 %s", current_status, phase)
                return

        # before_phase 钩子 / before_phase hook
        _invoke_hook(task, "before_phase", phase)

        log.info("========== 开始 ==========")

        # 如果已经是 running 状态（watcher 重试时），跳过 trigger，直接执行
        # If already in running state (watcher retry), skip trigger and execute directly
        if running_state and current_status == running_state:
            log.info("已在 %s，跳过 trigger 直接执行", running_state)
        elif trigger:
            log.info("触发状态转换：%s", trigger)
            transition(task_id, trigger)

        phase_func(task_id)
        log.info("========== 完成 ==========")

        # after_phase 钩子 / after_phase hook
        task = get_task(task_id)  # 重新读取，phase_func 内部可能已转换状态 / Re-read, phase_func may have changed state
        if task:
            _invoke_hook(task, "after_phase", phase)

    except InvalidTransitionError as e:
        log.warning("状态转换失败：%s", e)
        # on_phase_error 钩子 / on_phase_error hook
        task = get_task(task_id)
        if task:
            _invoke_hook(task, "on_phase_error", phase, e)
    except Exception as e:
        log.error("执行失败：%s", e, exc_info=True)
        # 记录失败到数据库 / Record failure to database
        with get_conn() as conn:
            conn.execute(
                "UPDATE tasks SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?", (now(), task_id)
            )
        # 立即通知用户 / Immediately notify user
        try:
            task = get_task(task_id)
            if task:
                notify(task, f"⚠️ 阶段 {phase} 执行失败：《{task['title']}》\n\n错误：{e}", event="error")
        except Exception as notify_err:
            log.warning("失败通知发送异常：%s", notify_err)
        # on_phase_error 钩子 / on_phase_error hook
        task = get_task(task_id)
        if task:
            _invoke_hook(task, "on_phase_error", phase, e)
    finally:
        reset_phase()
        remove_task_log_handler(log)
        release_lock(task_id)


# ──────────────────────────────────────────────
# 并行阶段执行
# Parallel phase execution
# ──────────────────────────────────────────────


def execute_parallel_phase(task_id: str, group_name: str) -> None:
    """Fork 逻辑：为并行组创建子任务并启动各子阶段。
    Fork logic: create sub-tasks for parallel group and launch each sub-phase.

    1. 父任务状态 → waiting_{group_name}
       Parent task state → waiting_{group_name}
    2. 为每个子阶段创建子 task
       Create sub-task for each sub-phase
    3. 对每个子 task 调用 run_in_background()
       Call run_in_background() for each sub-task
    """
    from core import registry
    from core.db import create_sub_task

    task = get_task(task_id)
    if not task:
        log.error("任务不存在: %s", task_id)
        return

    workflow_name = task.get("workflow", "")
    parallel_def = registry.get_parallel_def(workflow_name, group_name)
    if not parallel_def:
        log.error("未找到并行组定义：%s", group_name)
        return

    # 父任务转换到 waiting 状态 / Transition parent task to waiting state
    fork_trigger = f"start_{group_name}"
    try:
        transition(task_id, fork_trigger)
    except InvalidTransitionError as e:
        # 可能已经在 waiting 状态（重试场景）/ May already be in waiting state (retry scenario)
        task = get_task(task_id)
        if task and task["status"] != f"waiting_{group_name}":
            log.warning("并行组 fork 状态转换失败：%s", e)
            return

    # 创建子任务（使用 ignore_existing 避免 TOCTOU 竞态）
    # Create sub-tasks (use ignore_existing to avoid TOCTOU race condition)
    sub_phases = parallel_def.get("phases", [])
    for i, sub_phase in enumerate(sub_phases):
        sub_task_id = f"{task_id}__{sub_phase['name']}"

        initial_status = sub_phase["pending_state"]
        try:
            create_sub_task(
                parent_task_id=task_id,
                sub_task_id=sub_task_id,
                phase_name=sub_phase["name"],
                parallel_group=group_name,
                parallel_index=i,
                initial_status=initial_status,
                ignore_existing=True,
            )
            log.info("创建子任务：%s（阶段：%s）", sub_task_id, sub_phase["name"])
        except Exception as e:
            log.info("子任务已存在或创建失败：%s（%s）", sub_task_id, e)

    # 启动所有子任务 / Launch all sub-tasks
    for sub_phase in sub_phases:
        sub_task_id = f"{task_id}__{sub_phase['name']}"
        sub_task = get_task(sub_task_id)
        if sub_task and not sub_task["status"].endswith("_done") and sub_task["status"] != "cancelled":
            run_in_background(sub_task_id, sub_phase["name"])


def check_parallel_completion(sub_task_id: str) -> None:
    """Join 检查：每个子任务完成时调用，检查是否所有兄弟子任务已完成。
    Join check: called when each sub-task completes, checks if all sibling sub-tasks are done.

    如果全部完成 → 父任务自动 transition 到下一阶段。
    If all done → parent task automatically transitions to next phase.
    如果有失败 → 根据 fail_strategy 决定行为。
    If any failed → behavior determined by fail_strategy.
    """
    from core import registry
    from core.db import check_sub_tasks_status, get_sub_tasks

    sub_task = get_task(sub_task_id)
    if not sub_task:
        return

    parent_task_id = sub_task.get("parent_task_id")
    if not parent_task_id:
        return  # 非子任务 / Not a sub-task

    parent = get_task(parent_task_id)
    if not parent:
        return

    group_name = sub_task.get("parallel_group")
    if not group_name:
        return

    workflow_name = parent.get("workflow", "")
    parallel_def = registry.get_parallel_def(workflow_name, group_name)
    if not parallel_def:
        return

    fail_strategy = parallel_def.get("fail_strategy", "cancel_all")

    # 原子检查子任务状态（避免 TOCTOU 竞态）/ Atomically check sub-task statuses (avoid TOCTOU race)
    all_done, any_failed = check_sub_tasks_status(parent_task_id)

    if any_failed:
        if fail_strategy == "cancel_all":
            # 取消所有兄弟子任务 / Cancel all sibling sub-tasks
            subs = get_sub_tasks(parent_task_id)
            for s in subs:
                if s["id"] != sub_task_id and s["status"] != "cancelled":
                    try:
                        transition(s["id"], "cancel", note="兄弟子任务失败，级联取消")
                    except (InvalidTransitionError, Exception):
                        # 使用 force_transition 记录审计日志 / Use force_transition to record audit log
                        from core.state_machine import force_transition

                        force_transition(s["id"], "cancelled", note="兄弟子任务失败，强制取消")
            # 父任务回到 pending / Parent task back to pending
            fail_trigger = f"{group_name}_fail"
            try:
                transition(parent_task_id, fail_trigger, note="子任务失败，并行组回退")
            except InvalidTransitionError:
                pass
            return
        # fail_strategy == "continue"：等待其他子任务完成 / Wait for other sub-tasks to finish

    # 检查是否全部完成 / Check if all completed
    if all_done:
        join_trigger = f"{group_name}_complete"
        try:
            transition(parent_task_id, join_trigger, note="所有子任务完成")
            log.info("并行组 %s 全部完成，父任务继续", group_name)
            # 启动下一阶段 / Launch next phase
            next_phase = registry.get_next_phase(workflow_name, group_name)
            if next_phase:
                run_in_background(parent_task_id, next_phase)
        except InvalidTransitionError as e:
            log.warning("并行组 join 状态转换失败：%s", e)


def _set_phase_label(task_id: str, phase: str) -> None:
    """设置阶段日志标签，优先使用工作流定义中的 label
    Set phase log tag, preferring label from workflow definition."""
    task = get_task(task_id)
    if task:
        workflow_name = task.get("workflow", "")
        from core import registry

        phase_def = registry.get_phase(workflow_name, phase)
        if phase_def and phase_def.get("label"):
            set_phase(phase, label=phase_def["label"])
            return
    set_phase(phase)
