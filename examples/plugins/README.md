[中文](README.md) | [English](../README.en.md)

# 示例插件

本目录包含 autopilot 框架的示例插件实现，展示如何通过 `entry_points` 扩展框架功能。

插件开发详见 `docs/plugin-development.md`。

## autopilot-webui

基于浏览器的任务管理界面插件，展示 `cli_commands` 扩展点的使用方法。

**功能**：
- 仪表盘：任务统计、成功率、平均耗时、状态/工作流分布
- 任务列表：状态/工作流筛选、详情查看、流转日志时间线
- 工作流列表：卡片式展示名称、描述、阶段列表

**技术特点**：
- 基于标准库 `http.server.ThreadingHTTPServer`，零外部依赖
- 单文件 SPA（内嵌 CSS + 原生 JS），无构建步骤
- 只读 API，调用 `core.db` 和 `core.registry` 的现有接口

### 安装与使用

```bash
cd examples/plugins/autopilot-webui
pip install -e .

# 启动 WebUI
autopilot webui

# 自定义地址和端口
autopilot webui --host 0.0.0.0 --port 9090
```

访问 `http://127.0.0.1:8080` 查看管理界面。

### 目录结构

```
autopilot-webui/
├── pyproject.toml              # 包配置（entry_points 注册）
└── autopilot_webui/
    ├── __init__.py             # 导出 cli_commands
    ├── server.py               # HTTP 服务器 + JSON API + CLI 命令
    └── templates/
        └── index.html          # 单文件 SPA（内嵌 CSS/JS）
```
