#!/usr/bin/env python3
"""
初始化用户工作空间。
Initialize user workspace.

用法 / Usage：
  python3 bin/init_home.py                     # 初始化 ~/.autopilot/ / Initialize ~/.autopilot/
  python3 bin/init_home.py --path /custom/path  # 自定义路径 / Custom path
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

FRAMEWORK_ROOT = Path(__file__).parent.parent


def main():
    parser = argparse.ArgumentParser(description="初始化 autopilot 用户工作空间")
    parser.add_argument(
        "--path",
        type=str,
        default=None,
        help="自定义工作空间路径（默认 ~/.autopilot/）",
    )
    args = parser.parse_args()

    if args.path:
        home = Path(args.path).expanduser()
    else:
        from core import AUTOPILOT_HOME

        home = AUTOPILOT_HOME

    print(f"初始化用户工作空间：{home}")

    # 创建目录结构 / Create directory structure
    dirs = [
        home / "workflows",
        home / "prompts",
        home / "runtime",
    ]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
        print(f"  ✓ {d}")

    # 复制示例工作流（支持 YAML 目录和单文件两种格式）
    # Copy example workflows (supports both YAML directory and single-file formats)
    examples_dir = FRAMEWORK_ROOT / "examples"
    if examples_dir.is_dir():
        for wf_dir in sorted(examples_dir.iterdir()):
            if not wf_dir.is_dir():
                continue

            yaml_file = wf_dir / "workflow.yaml"
            py_file = wf_dir / "workflow.py"

            if yaml_file.exists():
                # YAML 工作流：复制整个目录（workflow.yaml + workflow.py）
                # YAML workflow: copy entire directory (workflow.yaml + workflow.py)
                dest_dir = home / "workflows" / wf_dir.name
                dest_dir.mkdir(parents=True, exist_ok=True)
                for src_file in [yaml_file, py_file]:
                    if src_file.exists():
                        dest_file = dest_dir / src_file.name
                        if not dest_file.exists():
                            shutil.copy2(src_file, dest_file)
                            print(f"  ✓ {dest_file}（示例工作流）")
                        else:
                            print(f"  - {dest_file}（已存在，跳过）")
            elif py_file.exists():
                # 单文件 Python 工作流 / Single-file Python workflow
                dest = home / "workflows" / f"{wf_dir.name}.py"
                if not dest.exists():
                    shutil.copy2(py_file, dest)
                    print(f"  ✓ {dest}（示例工作流）")
                else:
                    print(f"  - {dest}（已存在，跳过）")

            # 复制示例提示词 / Copy example prompts
            prompts_dir = wf_dir / "prompts"
            if prompts_dir.is_dir():
                dest_prompts = home / "prompts" / wf_dir.name
                dest_prompts.mkdir(parents=True, exist_ok=True)
                for prompt_file in sorted(prompts_dir.iterdir()):
                    prompt_dest = dest_prompts / prompt_file.name
                    if not prompt_dest.exists():
                        shutil.copy2(prompt_file, prompt_dest)
                        print(f"  ✓ {prompt_dest}")

    print()
    print("初始化完成！")
    print()
    print("后续步骤：")
    print(f"  1. 编辑 {home / 'config.yaml'} 配置框架参数")
    print("  2. 运行 python bin/upgrade.py 初始化数据库")
    if args.path:
        print(f"  3. 设置环境变量：export AUTOPILOT_HOME={home}")


if __name__ == "__main__":
    main()
