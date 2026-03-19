#!/usr/bin/env python3
"""
Watcher 入口（由外部 cron 调用）
用法：python3 bin/watcher.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.watcher import main

if __name__ == "__main__":
    main()
