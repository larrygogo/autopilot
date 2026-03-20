"""统一日志模块：分级日志 + 任务级文件输出 + 阶段标签
Unified logging module: leveled logging + task-level file output + phase tags."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

_FMT = "%(asctime)s [%(levelname)s] [%(phase_tag)s] %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


class _PhaseFilter(logging.Filter):
    """注入 phase_tag 字段到日志记录
    Inject phase_tag field into log records."""

    def __init__(self):
        super().__init__()
        self.phase_tag = "SYSTEM"

    def filter(self, record):
        record.phase_tag = self.phase_tag
        return True


# 全局唯一的 phase filter 实例 / Global singleton phase filter instance
_phase_filter = _PhaseFilter()


def get_logger(name: str = "core") -> logging.Logger:
    """获取模块 logger（单例，只初始化一次 handler）
    Get module logger (singleton, handlers initialized only once)."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(logging.DEBUG)
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(logging.DEBUG)
        handler.setFormatter(logging.Formatter(_FMT, datefmt=_DATEFMT))
        logger.addHandler(handler)
        logger.addFilter(_phase_filter)
    return logger


def set_phase(phase: str, label: str | None = None) -> None:
    """设置当前阶段标签
    Set current phase tag."""
    _phase_filter.phase_tag = label if label else phase.upper()


def reset_phase() -> None:
    """重置阶段标签
    Reset phase tag to default."""
    _phase_filter.phase_tag = "SYSTEM"


def add_task_log_handler(logger: logging.Logger, task_dir: str | Path) -> None:
    """为 logger 添加任务级文件 handler（写入 workflow.log）
    Add task-level file handler to logger (writes to workflow.log)."""
    log_path = Path(task_dir) / "workflow.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    # 避免重复添加同一文件的 handler / Avoid duplicate handlers for the same file
    for h in logger.handlers:
        if isinstance(h, logging.FileHandler) and h.baseFilename == str(log_path.resolve()):
            return

    handler = logging.FileHandler(str(log_path), mode="a", encoding="utf-8")
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(logging.Formatter(_FMT, datefmt=_DATEFMT))
    logger.addHandler(handler)


def remove_task_log_handler(logger: logging.Logger) -> None:
    """移除所有文件 handler（阶段结束时调用）
    Remove all file handlers (called when phase ends)."""
    for h in list(logger.handlers):
        if isinstance(h, logging.FileHandler):
            h.close()
            logger.removeHandler(h)
