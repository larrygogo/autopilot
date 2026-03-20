# 安全政策

## 支持的版本

| 版本 | 支持状态 |
|------|----------|
| 0.2.x | ✅ 安全更新 |
| < 0.2 | ❌ 不再支持 |

## 报告漏洞

如果你发现了安全漏洞，**请不要**在公开的 Issue 中报告。

请通过以下方式私下报告：

1. 使用 GitHub 的 [Private vulnerability reporting](https://github.com/larrygogo/autopilot/security/advisories/new) 功能
2. 或发送邮件至项目维护者

请在报告中包含：

- 漏洞描述
- 复现步骤
- 影响范围
- 你建议的修复方案（如果有）

我们会在 **48 小时**内确认收到报告，并在 **7 天**内提供初步评估。

## 安全考虑

autopilot 作为本地任务编排引擎，请注意以下安全事项：

- **工作流代码执行**：工作流的 `workflow.py` 中的函数会被直接执行，请仅运行受信任的工作流代码
- **SQLite 数据库**：运行时数据存储在本地 SQLite 中，确保 `AUTOPILOT_HOME` 目录权限正确
- **配置文件**：`config.yaml` 可能包含 webhook URL 等敏感信息，请勿提交到公开仓库
