[中文](README.md) | [English](README.en.md)

# 示例

本目录包含 autopilot 框架的示例工作流。

## 目录结构

```
examples/
└── workflows/          # 示例工作流（参考实现）
    ├── dev/            # 完整开发流程（5 阶段，含 git push + gh PR）
    ├── req_review/     # 需求评审流程（2 阶段）
    ├── doc_gen/        # 文档生成与评审
    ├── parallel_build/ # 并行构建流程（fork/join）
    ├── data_pipeline/  # 数据处理流水线（前向跳转 + 多终态）
    └── with_human/     # 人机交互示例（gate 审批 + ask_user 提问）
```

## 工作流示例

详见 [`workflows/README.md`](workflows/README.md)。

使用 `autopilot init` 自动安装示例工作流到 `~/.autopilot/workflows/`。
