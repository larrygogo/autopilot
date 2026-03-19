"""
基础设施层：通用工具函数
包含锁机制、通知分发、任务目录管理
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import IO

from core import AUTOPILOT_HOME
from core.logger import get_logger

log = get_logger()

# ──────────────────────────────────────────────────────────
# 路径常量
# ──────────────────────────────────────────────────────────

TASKS_DIR = AUTOPILOT_HOME / "runtime/tasks"


# ──────────────────────────────────────────────────────────
# 锁机制（跨平台：fcntl.flock on Unix / msvcrt.locking on Windows）
# ──────────────────────────────────────────────────────────

_IS_WINDOWS = sys.platform == "win32"
if _IS_WINDOWS:
    import msvcrt

    _LOCK_DIR = Path(tempfile.gettempdir())
else:
    import fcntl

    _LOCK_DIR = Path("/tmp")

_lock_fds = {}  # task_id -> fd，持有引用防止 GC


def _lock_path(task_id: str) -> str:
    return str(_LOCK_DIR / f"wf_task_{task_id}.lock")


def is_locked(task_id: str) -> bool:
    """检查任务是否已有进程持有锁（非阻塞尝试）"""
    path = _lock_path(task_id)
    try:
        fd = open(path, "w")
        if _IS_WINDOWS:
            msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
        fd.close()
        return False
    except (BlockingIOError, OSError):
        return True
    except Exception:
        return False


def acquire_lock(task_id: str) -> IO | None:
    """原子获取锁，成功返回 fd，失败返回 None"""
    path = _lock_path(task_id)
    try:
        fd = open(path, "w")
        if _IS_WINDOWS:
            msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd.write(str(os.getpid()))
        fd.flush()
        _lock_fds[task_id] = fd  # 持有引用
        return fd
    except (BlockingIOError, OSError):
        fd.close()
        return None


def release_lock(task_id: str) -> None:
    """释放锁"""
    fd = _lock_fds.pop(task_id, None)
    if fd:
        try:
            if _IS_WINDOWS:
                msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
            fd.close()
        except Exception:
            pass


# ──────────────────────────────────────────────────────────
# 通知分发（通用：从工作流注册表获取 notify_func）
# ──────────────────────────────────────────────────────────


def notify(task: dict, message: str, media_path: str | None = None, event: str = "info") -> None:
    """
    通用通知分发：
    1. 工作流 notify_func 存在则调用（覆盖语义）并 return
    2. 框架多后端分发（core.notify.dispatch）
    3. 两者都没有 → log.info 兜底
    """
    workflow_name = task.get("workflow", "")

    # 1. 工作流自定义 notify_func（覆盖语义）
    try:
        from core import registry

        wf = registry.get_workflow(workflow_name)
        if wf and "notify_func" in wf:
            wf["notify_func"](task, message, media_path)
            return
    except Exception as e:
        log.debug("工作流 notify_func 调用失败：%s", e)

    # 2. 框架多后端分发
    try:
        from core.notify import dispatch

        if dispatch(task, message, event=event, media_path=media_path):
            return
    except Exception as e:
        log.debug("框架通知分发失败：%s", e)

    # 3. 兜底日志
    log.info("通知: %s", message[:120])


# ──────────────────────────────────────────────────────────
# 任务目录
# ──────────────────────────────────────────────────────────


def get_task_dir(task_id: str) -> Path:
    d = TASKS_DIR / task_id
    d.mkdir(parents=True, exist_ok=True)
    return d
