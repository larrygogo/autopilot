"""
Runner：阶段编排引擎（push 模型核心）
阶段函数已迁移到 workflows/ 下各模块，runner 只负责：
- execute_phase()：从注册表查阶段配置和函数并执行
- run_in_background()：非阻塞启动下一阶段
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


# ──────────────────────────────────────────────────────────
# 后台启动（push 模型的核心）
# ──────────────────────────────────────────────────────────


def run_in_background(task_id: str, phase: str) -> None:
    """在后台子进程中运行下一阶段（非阻塞）"""
    script = Path(__file__).parent.parent / "bin" / "run_phase.py"
    subprocess.Popen(
        [sys.executable, str(script), task_id, phase],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


# ──────────────────────────────────────────────────────────
# 阶段执行引擎
# ──────────────────────────────────────────────────────────


def _get_phase_config_and_func(task: dict, phase: str):
    """从注册表查阶段配置和执行函数"""
    workflow_name = task.get("workflow", "")

    # 确保工作流已注册
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
    log.warning("未找到工作流 %s 的阶段 %s，尝试 fallback", workflow_name, phase)
    return None, None


def _invoke_hook(task: dict, hook_name: str, phase: str, error: Exception | None = None) -> None:
    """安全调用工作流钩子，异常只记日志不中断主流程"""
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


def execute_phase(task_id: str, phase: str) -> None:
    """执行指定阶段（带原子锁保护，防止双重状态转换）"""
    fd = acquire_lock(task_id)
    if fd is None:
        log.warning("已有进程在运行，跳过 %s", phase)
        return

    # 挂载任务级文件日志 + 设置阶段标签
    task_dir = get_task_dir(task_id)
    add_task_log_handler(log, task_dir)

    # 动态设置阶段标签（优先使用工作流定义中的 label）
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

        # 获取转换表用于判断是否已被推进
        workflow_name = task.get("workflow", "")
        from core import registry

        transitions = registry.build_transitions(workflow_name)

        # 检查任务是否已被其他进程推进到后续状态（防止重复执行）
        if trigger and current_status != running_state:
            expected_from = [s for s, trs in transitions.items() if any(t == trigger for t, _ in trs)]
            if current_status not in expected_from and current_status != running_state:
                log.info("任务已被推进到 %s，跳过 %s", current_status, phase)
                return

        # before_phase 钩子
        _invoke_hook(task, "before_phase", phase)

        log.info("========== 开始 ==========")

        # 如果已经是 running 状态（watcher 重试时），跳过 trigger，直接执行
        if running_state and current_status == running_state:
            log.info("已在 %s，跳过 trigger 直接执行", running_state)
        elif trigger:
            log.info("触发状态转换：%s", trigger)
            transition(task_id, trigger)

        phase_func(task_id)
        log.info("========== 完成 ==========")

        # after_phase 钩子
        task = get_task(task_id)  # 重新读取，phase_func 内部可能已转换状态
        if task:
            _invoke_hook(task, "after_phase", phase)

    except InvalidTransitionError as e:
        log.warning("状态转换失败：%s", e)
        # on_phase_error 钩子
        task = get_task(task_id)
        if task:
            _invoke_hook(task, "on_phase_error", phase, e)
    except Exception as e:
        log.error("执行失败：%s", e, exc_info=True)
        # 记录失败到数据库
        with get_conn() as conn:
            conn.execute(
                "UPDATE tasks SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?", (now(), task_id)
            )
        # 立即通知用户
        try:
            task = get_task(task_id)
            if task:
                notify(task, f"⚠️ 阶段 {phase} 执行失败：《{task['title']}》\n\n错误：{e}", event="error")
        except Exception:
            pass
        # on_phase_error 钩子
        task = get_task(task_id)
        if task:
            _invoke_hook(task, "on_phase_error", phase, e)
    finally:
        reset_phase()
        remove_task_log_handler(log)
        release_lock(task_id)


# ──────────────────────────────────────────────────────────
# 并行阶段执行
# ──────────────────────────────────────────────────────────


def execute_parallel_phase(task_id: str, group_name: str) -> None:
    """
    Fork 逻辑：为并行组创建子任务并启动各子阶段。

    1. 父任务状态 → waiting_{group_name}
    2. 为每个子阶段创建子 task
    3. 对每个子 task 调用 run_in_background()
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

    # 父任务转换到 waiting 状态
    fork_trigger = f"start_{group_name}"
    try:
        transition(task_id, fork_trigger)
    except InvalidTransitionError as e:
        # 可能已经在 waiting 状态（重试场景）
        task = get_task(task_id)
        if task and task["status"] != f"waiting_{group_name}":
            log.warning("并行组 fork 状态转换失败：%s", e)
            return

    # 创建子任务
    sub_phases = parallel_def.get("phases", [])
    for i, sub_phase in enumerate(sub_phases):
        sub_task_id = f"{task_id}__{sub_phase['name']}"

        # 检查是否已存在（重试场景）
        existing = get_task(sub_task_id)
        if existing:
            if existing["status"] not in ("cancelled",):
                log.info("子任务已存在：%s（状态：%s）", sub_task_id, existing["status"])
                continue
            else:
                # 已取消的子任务，跳过
                continue

        initial_status = sub_phase["pending_state"]
        create_sub_task(
            parent_task_id=task_id,
            sub_task_id=sub_task_id,
            phase_name=sub_phase["name"],
            parallel_group=group_name,
            parallel_index=i,
            initial_status=initial_status,
        )
        log.info("创建子任务：%s（阶段：%s）", sub_task_id, sub_phase["name"])

    # 启动所有子任务
    for sub_phase in sub_phases:
        sub_task_id = f"{task_id}__{sub_phase['name']}"
        sub_task = get_task(sub_task_id)
        if sub_task and not sub_task["status"].endswith("_done") and sub_task["status"] != "cancelled":
            run_in_background(sub_task_id, sub_phase["name"])


def check_parallel_completion(sub_task_id: str) -> None:
    """
    Join 检查：每个子任务完成时调用，检查是否所有兄弟子任务已完成。

    如果全部完成 → 父任务自动 transition 到下一阶段。
    如果有失败 → 根据 fail_strategy 决定行为。
    """
    from core import registry
    from core.db import all_sub_tasks_done, any_sub_task_failed, get_sub_tasks

    sub_task = get_task(sub_task_id)
    if not sub_task:
        return

    parent_task_id = sub_task.get("parent_task_id")
    if not parent_task_id:
        return  # 非子任务

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

    # 检查是否有子任务失败
    if any_sub_task_failed(parent_task_id):
        if fail_strategy == "cancel_all":
            # 取消所有兄弟子任务
            subs = get_sub_tasks(parent_task_id)
            for s in subs:
                if s["id"] != sub_task_id and s["status"] != "cancelled":
                    try:
                        transition(s["id"], "cancel", note="兄弟子任务失败，级联取消")
                    except (InvalidTransitionError, Exception):
                        # 强制设置状态
                        with get_conn() as conn:
                            conn.execute(
                                "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?",
                                (now(), s["id"]),
                            )
            # 父任务回到 pending
            fail_trigger = f"{group_name}_fail"
            try:
                transition(parent_task_id, fail_trigger, note="子任务失败，并行组回退")
            except InvalidTransitionError:
                pass
            return
        # fail_strategy == "continue"：等待其他子任务完成

    # 检查是否全部完成
    if all_sub_tasks_done(parent_task_id):
        join_trigger = f"{group_name}_complete"
        try:
            transition(parent_task_id, join_trigger, note="所有子任务完成")
            log.info("并行组 %s 全部完成，父任务继续", group_name)
            # 启动下一阶段
            next_phase = registry.get_next_phase(workflow_name, group_name)
            if next_phase:
                run_in_background(parent_task_id, next_phase)
        except InvalidTransitionError as e:
            log.warning("并行组 join 状态转换失败：%s", e)


def _set_phase_label(task_id: str, phase: str) -> None:
    """设置阶段日志标签，优先使用工作流定义中的 label"""
    task = get_task(task_id)
    if task:
        workflow_name = task.get("workflow", "")
        from core import registry

        phase_def = registry.get_phase(workflow_name, phase)
        if phase_def and phase_def.get("label"):
            from core.logger import _phase_filter

            _phase_filter.phase_tag = phase_def["label"]
            return
    set_phase(phase)
