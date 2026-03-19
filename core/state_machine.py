"""
状态机：执行状态转换，记录日志
转换表完全由工作流注册表提供，框架不内置任何业务状态
"""

from __future__ import annotations

from core.db import _TABLE_COLUMNS, get_conn, now


class InvalidTransitionError(Exception):
    pass


def _resolve_transitions(task_id: str, conn) -> dict[str, list[tuple[str, str]]]:
    """
    解析任务对应的转换表。
    从工作流注册表查询，查不到返回空字典。
    """
    row = conn.execute("SELECT workflow FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return {}

    workflow_name = row["workflow"] if row["workflow"] else ""

    try:
        from core import registry

        transitions = registry.build_transitions(workflow_name)
        if transitions:
            return transitions
    except Exception:
        pass

    return {}


def transition(
    task_id: str,
    trigger: str,
    note: str | None = None,
    extra_updates: dict | None = None,
    transitions: dict | None = None,
) -> tuple[str, str]:
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
    original_isolation = conn.isolation_level
    conn.isolation_level = None  # 手动事务管理，避免与 autocommit 冲突
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if not row:
                raise ValueError(f"任务不存在：{task_id}")

            from_status = row["status"]

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
                    f"非法转换：{from_status} --[{trigger}]--> ??? （允许的 trigger：{[t for t, _ in allowed]}）"
                )

            # 构建更新字段（透明区分列字段 vs extra JSON）
            import json

            col_updates = {"status": to_status, "updated_at": now(), "started_at": now()}
            extra_fields = {}

            if extra_updates:
                for k, v in extra_updates.items():
                    if k in _TABLE_COLUMNS:
                        col_updates[k] = v
                    else:
                        extra_fields[k] = v

            if extra_fields:
                # 读取当前 extra 并合并
                current_row = conn.execute("SELECT extra FROM tasks WHERE id = ?", (task_id,)).fetchone()
                try:
                    current_extra = json.loads(current_row["extra"]) if current_row and current_row["extra"] else {}
                except (json.JSONDecodeError, TypeError):
                    current_extra = {}
                current_extra.update(extra_fields)
                col_updates["extra"] = json.dumps(current_extra, ensure_ascii=False)

            set_clause = ", ".join(f"{k} = ?" for k in col_updates)
            values = list(col_updates.values()) + [task_id]
            conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", values)

            # 记录日志
            conn.execute(
                """
                INSERT INTO task_logs (task_id, from_status, to_status, trigger, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """,
                (task_id, from_status, to_status, trigger, note, now()),
            )

            conn.execute("COMMIT")
            return from_status, to_status

        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.isolation_level = original_isolation
    # 不 close()：复用线程本地连接


def can_transition(task_id: str, trigger: str) -> bool:
    """检查是否可以执行某个 trigger"""
    from core.db import get_task

    task = get_task(task_id)
    if not task:
        return False

    workflow_name = task.get("workflow", "")
    try:
        from core import registry

        transitions = registry.build_transitions(workflow_name)
        if transitions:
            allowed = transitions.get(task["status"], [])
            return any(t == trigger for t, _ in allowed)
    except Exception:
        pass

    return False


def get_available_triggers(task_id: str) -> list[str]:
    """获取当前状态下可用的 trigger 列表"""
    from core.db import get_task

    task = get_task(task_id)
    if not task:
        return []

    workflow_name = task.get("workflow", "")
    try:
        from core import registry

        transitions = registry.build_transitions(workflow_name)
        if transitions:
            return [t for t, _ in transitions.get(task["status"], [])]
    except Exception:
        pass

    return []
