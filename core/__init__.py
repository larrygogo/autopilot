"""
autopilot 框架核心包
"""

from __future__ import annotations

import os
from pathlib import Path

__version__ = "0.2.0"

AUTOPILOT_HOME = Path(os.environ.get("AUTOPILOT_HOME") or Path.home() / ".autopilot").expanduser()
