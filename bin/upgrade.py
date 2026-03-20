#!/usr/bin/env python3
"""
数据库升级 CLI。
Database upgrade CLI.

用法 / Usage：
  python3 bin/upgrade.py              # 执行所有待执行迁移 / Run all pending migrations
  python3 bin/upgrade.py --status     # 查看当前版本和待迁移数 / Show current version and pending count
  python3 bin/upgrade.py --dry-run    # 预览将执行的迁移 / Preview pending migrations
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core import AUTOPILOT_HOME, __version__
from core.db import get_conn, init_db
from core.migrate import (
    ensure_schema_version_table,
    get_current_version,
    get_pending_migrations,
    run_pending_migrations,
)


def main():
    parser = argparse.ArgumentParser(description="autopilot 数据库升级")
    parser.add_argument("--status", action="store_true", help="查看当前版本")
    parser.add_argument("--dry-run", action="store_true", help="预览待执行迁移")
    args = parser.parse_args()

    print(f"autopilot v{__version__}")
    print(f"AUTOPILOT_HOME: {AUTOPILOT_HOME}")
    print()

    # 确保数据库存在 / Ensure database exists
    init_db()
    conn = get_conn()
    ensure_schema_version_table(conn)

    current = get_current_version(conn)
    pending = get_pending_migrations(conn)

    if args.status:
        print(f"当前 schema 版本：{current}")
        print(f"待执行迁移数：{len(pending)}")
        if pending:
            for v, name, _ in pending:
                print(f"  - {v:03d}_{name}")
        else:
            print("已是最新版本。")
        return

    if args.dry_run:
        if not pending:
            print("没有待执行的迁移。")
            return
        print(f"将执行以下 {len(pending)} 个迁移：")
        for v, name, _ in pending:
            print(f"  - {v:03d}_{name}")
        return

    if not pending:
        print("数据库已是最新版本。")
        return

    print(f"当前版本：{current}，待执行 {len(pending)} 个迁移...")
    try:
        executed = run_pending_migrations(conn)
        new_version = get_current_version(conn)
        print(f"✓ 升级完成：{current} → {new_version}（执行了 {executed} 个迁移）")
    except Exception as e:
        print(f"✗ 升级失败：{e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
