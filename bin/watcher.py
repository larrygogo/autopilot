#!/usr/bin/env python3
"""
Watcher 入口（由外部 cron 调用）
Watcher entry point (called by external cron).

用法 / Usage：python3 bin/watcher.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

if __name__ == "__main__":
    from core.db import init_db

    init_db()

    import core.workflows  # noqa: F401, I001 — 触发工作流发现 / trigger workflow discovery
    from core.watcher import main

    main()
