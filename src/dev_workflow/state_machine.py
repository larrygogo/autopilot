"""
状态机：定义合法的状态转换，执行转换时记录日志
支持动态转换表（从工作流注册表查询）
"""
from __future__ import annotations

import sqlite3
from dev_workflow.db import get_conn, now

# ──────────────────────────────────────────────────────────
# 默认转换表（dev 工作流，作为 fallback）
# ──────────────────────────────────────────────────────────

STATES = [
    'pending_design',    # 待设计
    'designing',         # 设计中
    'pending_review',    # 待评审
    'reviewing',         # 评审中
    'review_rejected',   # 方案评审拒绝
    'developing',        # 待开发
    'in_development',    # 开发中
    'code_reviewing',    # 代码审查中
    'code_rejected',     # 代码审查拒绝
    'pr_submitted',      # PR 已提交（终态）
    'cancelled',         # 已取消（终态）
]

TERMINAL_STATES = ['pr_submitted', 'cancelled']

# 合法转换：{当前状态: [(trigger, 目标状态), ...]}
VALID_TRANSITIONS = {
    'pending_design':  [('start_design',    'designing'),
                        ('cancel',          'cancelled')],
    'designing':       [('design_complete', 'pending_review'),
                        ('design_fail',     'pending_design'),
                        ('cancel',          'cancelled')],
    'pending_review':  [('start_review',    'reviewing'),
                        ('cancel',          'cancelled')],
    'reviewing':       [('review_pass',     'developing'),
                        ('review_reject',   'review_rejected'),
                        ('cancel',          'cancelled')],
    'review_rejected': [('retry_design',    'pending_design'),
                        ('cancel',          'cancelled')],
    'developing':      [('start_dev',       'in_development'),
                        ('cancel',          'cancelled')],
    'in_development':  [('dev_complete',    'code_reviewing'),
                        ('dev_fail',        'developing'),
                        ('cancel',          'cancelled')],
    'code_reviewing':  [('code_pass',       'pr_submitted'),
                        ('code_reject',     'code_rejected'),
                        ('cancel',          'cancelled')],
    'code_rejected':   [('retry_dev',       'in_development'),
                        ('cancel',          'cancelled')],
}


class InvalidTransitionError(Exception):
    pass


def _resolve_transitions(task_id: str, conn) -> dict[str, list[tuple[str, str]]]:
    """
    解析任务对应的转换表。
    优先从工作流注册表查询，fallback 到 VALID_TRANSITIONS。
    """
    row = conn.execute('SELECT workflow FROM tasks WHERE id = ?', (task_id,)).fetchone()
    if not row:
        return VALID_TRANSITIONS

    workflow_name = row['workflow'] if row['workflow'] else 'dev'

    # 尝试从注册表获取
    try:
        from dev_workflow import registry
        transitions = registry.build_transitions(workflow_name)
        if transitions:
            return transitions
    except Exception:
        pass

    return VALID_TRANSITIONS


def transition(task_id: str, trigger: str, note: str | None = None,
               extra_updates: dict | None = None,
               transitions: dict | None = None) -> tuple[str, str]:
    """
    执行状态转换（原子操作，完全手动事务管理）

    Args:
        task_id: 任务 ID
        trigger: 触发器名称
        note: 可选备注
        extra_updates: 额外要更新的字段 dict（如 rejection_counts）
        transitions: 可选，外部传入的转换表。不传时自动从任务的 workflow 查注册表。

    Returns:
        (from_status, to_status)

    Raises:
        InvalidTransitionError: 非法状态转换
    """
    conn = get_conn()
    conn.execute('BEGIN IMMEDIATE')
    try:
        row = conn.execute('SELECT * FROM tasks WHERE id = ?', (task_id,)).fetchone()
        if not row:
            raise ValueError(f'任务不存在：{task_id}')

        from_status = row['status']

        # 确定使用的转换表
        if transitions is None:
            transitions = _resolve_transitions(task_id, conn)

        # 查找合法目标状态
        allowed = transitions.get(from_status, [])
        to_status = None
        for t, dest in allowed:
            if t == trigger:
                to_status = dest
                break

        if to_status is None:
            raise InvalidTransitionError(
                f'非法转换：{from_status} --[{trigger}]--> ??? '
                f'（允许的 trigger：{[t for t, _ in allowed]}）'
            )

        # 构建更新字段
        updates = {'status': to_status, 'updated_at': now(), 'started_at': now()}
        if extra_updates:
            updates.update(extra_updates)

        set_clause = ', '.join(f'{k} = ?' for k in updates)
        values = list(updates.values()) + [task_id]
        conn.execute(f'UPDATE tasks SET {set_clause} WHERE id = ?', values)

        # 记录日志
        conn.execute('''
            INSERT INTO task_logs (task_id, from_status, to_status, trigger, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (task_id, from_status, to_status, trigger, note, now()))

        conn.execute('COMMIT')
        return from_status, to_status

    except Exception:
        conn.execute('ROLLBACK')
        raise
    # 不 close()：复用线程本地连接


def can_transition(task_id: str, trigger: str) -> bool:
    """检查是否可以执行某个 trigger"""
    from dev_workflow.db import get_task
    task = get_task(task_id)
    if not task:
        return False

    # 动态获取转换表
    workflow_name = task.get('workflow', 'dev')
    try:
        from dev_workflow import registry
        transitions = registry.build_transitions(workflow_name)
        if transitions:
            allowed = transitions.get(task['status'], [])
            return any(t == trigger for t, _ in allowed)
    except Exception:
        pass

    allowed = VALID_TRANSITIONS.get(task['status'], [])
    return any(t == trigger for t, _ in allowed)


def get_available_triggers(task_id: str) -> list[str]:
    """获取当前状态下可用的 trigger 列表"""
    from dev_workflow.db import get_task
    task = get_task(task_id)
    if not task:
        return []

    # 动态获取转换表
    workflow_name = task.get('workflow', 'dev')
    try:
        from dev_workflow import registry
        transitions = registry.build_transitions(workflow_name)
        if transitions:
            return [t for t, _ in transitions.get(task['status'], [])]
    except Exception:
        pass

    return [t for t, _ in VALID_TRANSITIONS.get(task['status'], [])]
