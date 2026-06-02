# 截图规范

本目录存放文档中使用的截图文件。

## 截图要求

- **浏览器窗口**：1280×800 分辨率
- **任务数据**：使用通用示例数据（DOC-001、HELLO-001 等），不包含真实项目信息
- **文件命名**：kebab-case PNG 格式，例如 `webui-dashboard.png`
- **隐私保护**：不包含个人路径、用户名、API 密钥等敏感信息

## 需要的截图

| 文件名 | 用途 | 使用位置 |
|--------|------|----------|
| `webui-dashboard.png` | Web UI 仪表盘页面 | quickstart.md |
| `webui-task-detail.png` | Web UI 任务详情页（含状态机图） | quickstart.md |
| `webui-workflow-list.png` | Web UI 工作流列表页 | quickstart.md |

## 如何截图

1. 启动 daemon：`autopilot daemon start`
2. 创建一些示例任务用于展示
3. 打开 Web UI：`autopilot dashboard`（浏览器访问 `http://127.0.0.1:6180`）
4. 使用浏览器开发者工具设置视窗为 1280×800
5. 截图并保存为 PNG 格式到本目录
