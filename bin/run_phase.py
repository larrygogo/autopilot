#!/usr/bin/env python3
"""
后台阶段执行入口（由 runner.run_in_background 调用）
用法：python3 bin/run_phase.py <task_id> <phase>
"""

import sys
from pathlib import Path

# 把 src 加入路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.runner import execute_phase

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: run_phase.py <task_id> <phase>")
        sys.exit(1)
    execute_phase(sys.argv[1], sys.argv[2])
