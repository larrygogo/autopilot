"""
配置加载与校验
"""

from __future__ import annotations

import os
from pathlib import Path

from core import DEV_PILOT_HOME
from core.logger import get_logger

log = get_logger()


def load_config() -> dict:
    """加载配置文件，按优先级查找"""
    try:
        import yaml
    except ImportError:
        return {}
    env_cfg = os.environ.get("DEV_WORKFLOW_CONFIG", "")
    search_paths = [
        Path(env_cfg) if env_cfg else None,
        DEV_PILOT_HOME / "config.yaml",
        Path.cwd() / "config.yaml",
        Path(__file__).parent.parent / "config.yaml",
    ]
    for p in search_paths:
        if p and p.is_file():
            with open(p, encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
    return {}


# ──────────────────────────────────────────────────────────
# Schema 定义
# ──────────────────────────────────────────────────────────

_SCHEMA: dict[str, dict] = {
    "default_branch": {"type": str},
    "reqgenie": {
        "type": dict,
        "children": {
            "base_url": {"type": str},
            "op_vault": {"type": str},
            "op_item": {"type": str},
        },
    },
    "notify": {
        "type": dict,
        "children": {
            "channel": {"type": str},
            "target": {"type": str},
        },
    },
    "timeouts": {
        "type": dict,
        "children": {
            "design": {"type": int},
            "review": {"type": int},
            "development": {"type": int},
            "code_review": {"type": int},
            "pr_description": {"type": int},
        },
    },
    "agents": {
        "type": dict,
        "children": {
            "default": {"type": dict},
        },
    },
    "projects": {"type": dict},
}


def validate_config(config: dict) -> tuple[list[str], list[str]]:
    """
    校验配置字典。

    Returns:
        (errors, warnings) — errors 是类型错误，warnings 是未知 key
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(config, dict):
        errors.append("配置必须是 dict")
        return errors, warnings

    _validate_level(config, _SCHEMA, "", errors, warnings)
    return errors, warnings


def _validate_level(
    config: dict,
    schema: dict[str, dict],
    prefix: str,
    errors: list[str],
    warnings: list[str],
) -> None:
    """递归校验一层配置"""
    for key, value in config.items():
        full_key = f"{prefix}{key}" if not prefix else f"{prefix}.{key}"

        if key not in schema:
            warnings.append(f"未知配置项：{full_key}")
            continue

        spec = schema[key]
        expected_type = spec.get("type")

        if expected_type and not isinstance(value, expected_type):
            actual = type(value).__name__
            errors.append(f"{full_key} 类型错误：期望 {expected_type.__name__}，得到 {actual}")
            continue

        # 递归校验子级
        if isinstance(value, dict) and "children" in spec:
            _validate_level(value, spec["children"], full_key, errors, warnings)
