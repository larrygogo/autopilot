"""
dev-pilot 框架核心包
"""

from __future__ import annotations

import os
from pathlib import Path

__version__ = "0.2.0"

DEV_PILOT_HOME = Path(os.environ.get("DEV_PILOT_HOME") or Path.home() / ".dev-pilot").expanduser()
