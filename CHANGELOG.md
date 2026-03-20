# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 兼容性说明

当前处于 `0.x` 阶段，**任何 minor 版本都可能包含破坏性变更**（YAML 格式、CLI 参数、数据库 schema 等）。

升级前请查看对应版本的 **Breaking Changes** 章节，按迁移步骤操作。数据库变更通过 `autopilot upgrade` 自动迁移，YAML/CLI 变更会在此文档中提供手动迁移说明。

`1.0` 发布后将严格遵守语义化版本：patch = bugfix，minor = 向后兼容的新功能，major = 破坏性变更。

## [0.2.0] - 2026-03-17

### Added

- 第三方插件系统：通过 `entry_points` 自动发现和注册扩展（通知后端 / CLI 命令 / 全局钩子）
- 示例工作流添加 `[AI]` 标签标识 AI 驱动的工作流

### Changed

- 简化 `dev` 示例工作流，移除特定集成依赖
- 简化 `req_review` 示例工作流，移除特定集成依赖
- 移除框架核心中的 `default_branch` 硬编码

## [0.1.0] - 2026-03-15

### Added

- 核心状态机引擎，支持原子性状态转换
- YAML 声明式工作流定义，状态自动推导
- Push 模型：阶段完成后非阻塞启动下一阶段
- 并行阶段支持：`parallel:` 语法 + fork/join + 失败策略
- 跳转机制（驳回/前向跳转）：`reject` 语法糖 + `jump_trigger`/`jump_target`
- SQLite 持久化 + 数据库迁移引擎
- 文件锁并发安全保护
- Watcher 卡死任务检测与自动恢复
- 插件化工作流自动发现（`AUTOPILOT_HOME/workflows/`）
- 多后端通知系统（webhook / command）
- 统一 CLI（start / list / show / cancel / stats / workflows / validate / init / upgrade / watch）
- 用户空间分离（`AUTOPILOT_HOME`）
- 5 个示例工作流：dev / req_review / doc_gen / parallel_build / data_pipeline
- 完整双语文档（中文 + English）
- CI/CD：ruff lint + pytest 多版本矩阵测试

### Changed

- `reject_trigger`/`retry_target` 统一重命名为 `jump_trigger`/`jump_target`
- `knowledge/` 目录重命名为 `docs/`
- git 操作和 `run_claude()` 从框架核心移至示例工作流
- 移除框架核心中的工作流专属默认值

[0.2.0]: https://github.com/larrygogo/autopilot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/larrygogo/autopilot/releases/tag/v0.1.0
