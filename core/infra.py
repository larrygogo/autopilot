"""基础设施层：通用工具函数
Infrastructure layer: common utility functions.

包含锁机制、通知分发、任务目录管理
Includes locking mechanism, notification dispatch, and task directory management."""

from __future__ import annotations

import os
import re
import sys
import tempfile
import threading
from pathlib import Path
from typing import IO

from core import AUTOPILOT_HOME
from core.logger import get_logger

log = get_logger()

# ──────────────────────────────────────────────
# 路径常量
# Path constants
# ──────────────────────────────────────────────

TASKS_DIR = AUTOPILOT_HOME / "runtime/tasks"


# ──────────────────────────────────────────────
# 锁机制（跨平台：fcntl.flock on Unix / msvcrt.locking on Windows）
# Locking mechanism (cross-platform: fcntl.flock on Unix / msvcrt.locking on Windows)
# ──────────────────────────────────────────────

_IS_WINDOWS = sys.platform == "win32"
if _IS_WINDOWS:
    import msvcrt

    _LOCK_DIR = Path(tempfile.gettempdir())
else:
    import fcntl

    _LOCK_DIR = Path("/tmp")

_lock_fds_lock = threading.Lock()
_lock_fds: dict[str, IO] = {}  # task_id -> fd，持有引用防止 GC / task_id -> fd, hold reference to prevent GC

# task_id 合法字符：字母、数字、短线、下划线、点
# Valid task_id characters: letters, digits, hyphen, underscore, dot
_TASK_ID_RE = re.compile(r"^[\w.\-]+$")


def _validate_task_id(task_id: str) -> None:
    """校验 task_id 防止路径遍历
    Validate task_id to prevent path traversal."""
    if not _TASK_ID_RE.match(task_id):
        raise ValueError(f"非法 task_id（仅允许字母数字和 .-_）：{task_id}")


def _lock_path(task_id: str) -> str:
    _validate_task_id(task_id)
    return str(_LOCK_DIR / f"wf_task_{task_id}.lock")


def _open_lock_file(path: str):
    """打开锁文件（跨平台安全）
    Open lock file (cross-platform safe).

    Windows 上用 a+ 模式避免截断已被锁定的文件导致 PermissionError。
    Uses a+ mode on Windows to avoid truncating a locked file which causes PermissionError."""
    if _IS_WINDOWS:
        fd = open(path, "a+")
        # 确保文件有内容以支持 msvcrt.locking 锁定 1 字节
        # Ensure file has content for msvcrt.locking to lock 1 byte
        fd.seek(0, 2)  # seek to end
        if fd.tell() == 0:
            fd.write(" ")
            fd.flush()
        fd.seek(0)
        return fd
    return open(path, "w")


def is_locked(task_id: str) -> bool:
    """检查任务是否已有进程持有锁（非阻塞尝试）
    Check if a task lock is held by another process (non-blocking attempt)."""
    path = _lock_path(task_id)
    fd = None
    try:
        fd = _open_lock_file(path)
        if _IS_WINDOWS:
            msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except (BlockingIOError, OSError):
        return True
    except Exception as e:
        log.debug("检查锁状态异常：%s", e)
        return False
    finally:
        if fd:
            try:
                fd.close()
            except OSError:
                pass


def acquire_lock(task_id: str) -> IO | None:
    """原子获取锁，成功返回 fd，失败返回 None
    Atomically acquire lock; returns fd on success, None on failure."""
    path = _lock_path(task_id)
    fd = None
    try:
        fd = _open_lock_file(path)
        if _IS_WINDOWS:
            msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd.seek(0)
        fd.truncate()
        fd.write(str(os.getpid()))
        fd.flush()
        with _lock_fds_lock:
            _lock_fds[task_id] = fd  # 持有引用 / Hold reference
        return fd
    except (BlockingIOError, OSError):
        if fd:
            try:
                fd.close()
            except OSError:
                pass
        return None
    except Exception as e:
        log.warning("获取锁异常（task_id=%s）：%s", task_id, e)
        if fd:
            try:
                fd.close()
            except OSError:
                pass
        return None


def release_lock(task_id: str) -> None:
    """释放锁
    Release lock."""
    with _lock_fds_lock:
        fd = _lock_fds.pop(task_id, None)
    if fd:
        try:
            if _IS_WINDOWS:
                # msvcrt.locking 从当前位置操作，需回到锁定位置
                # msvcrt.locking operates from current position, seek back
                fd.seek(0)
                msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
        except Exception as e:
            log.debug("释放锁异常（task_id=%s）：%s", task_id, e)
        finally:
            fd.close()


# ──────────────────────────────────────────────
# 通知分发（通用：从工作流注册表获取 notify_func）
# Notification dispatch (generic: get notify_func from workflow registry)
# ──────────────────────────────────────────────


def notify(task: dict, message: str, media_path: str | None = None, event: str = "info") -> None:
    """通用通知分发
    Generic notification dispatch.

    1. 工作流 notify_func 存在则调用（覆盖语义）并 return
       If workflow notify_func exists, call it (override semantics) and return
    2. 框架多后端分发（core.notify.dispatch）
       Framework multi-backend dispatch (core.notify.dispatch)
    3. 两者都没有 → log.info 兜底
       Neither available → fallback to log.info
    """
    workflow_name = task.get("workflow", "")

    # 1. 工作流自定义 notify_func（覆盖语义）/ Workflow custom notify_func (override semantics)
    try:
        from core import registry

        wf = registry.get_workflow(workflow_name)
        if wf and "notify_func" in wf:
            wf["notify_func"](task, message, media_path)
            return
    except Exception as e:
        log.debug("工作流 notify_func 调用失败：%s", e)

    # 2. 框架多后端分发 / Framework multi-backend dispatch
    try:
        from core.notify import dispatch

        if dispatch(task, message, event=event, media_path=media_path):
            return
    except Exception as e:
        log.debug("框架通知分发失败：%s", e)

    # 3. 兜底日志 / Fallback logging
    log.info("通知: %s", message[:120])


# ──────────────────────────────────────────────
# 任务目录
# Task directory
# ──────────────────────────────────────────────


def get_task_dir(task_id: str) -> Path:
    """获取任务工作目录（自动创建）
    Get task working directory (auto-created)."""
    _validate_task_id(task_id)
    d = TASKS_DIR / task_id
    d.mkdir(parents=True, exist_ok=True)
    return d
