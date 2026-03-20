[中文](README.md) | [English](README.en.md)

# 示例

本目录包含 autopilot 框架的示例工作流和插件实现。

## 目录结构

```
examples/
├── workflows/          # 示例工作流（5 个参考实现）
│   ├── dev/            # 完整开发流程（5 阶段）
│   ├── req_review/     # 需求评审流程（2 阶段）
│   ├── doc_gen/        # 文档生成与评审
│   ├── parallel_build/ # 并行构建流程（fork/join）
│   └── data_pipeline/  # 数据处理流水线（前向跳转 + 多终态）
└── plugins/            # 示例插件
    └── autopilot-webui/ # WebUI 管理界面插件
```

## 工作流示例

详见 [`workflows/README.md`](workflows/README.md)。

使用 `autopilot init` 自动安装示例工作流到 `~/.autopilot/workflows/`。

## 插件示例

详见 [`plugins/README.md`](plugins/README.md)。

插件通过 `pip install` 安装后自动注册，无需修改框架代码。
