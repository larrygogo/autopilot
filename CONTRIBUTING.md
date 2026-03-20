# 贡献指南

感谢你对 autopilot 的关注！欢迎任何形式的贡献：Bug 报告、功能建议、代码提交、文档改进。

## 开发环境

```bash
git clone https://github.com/larrygogo/autopilot && cd autopilot
pip install -e ".[dev]"
autopilot init
autopilot upgrade
```

## 代码规范

- **Python 3.10+**，所有模块使用 `from __future__ import annotations`
- **ruff** 格式化与 lint（行宽 120）
- 核心函数必须有**类型提示**
- 框架核心（`core/`）**不得引入任何工作流专属的常量或逻辑**

```bash
# 提交前务必通过
ruff check . && ruff format --check .
pytest tests/ -v
```

## 提交流程

### 1. Fork & 创建分支

从 `main` 分支创建功能分支，命名格式：`类型/简要描述`

```bash
git checkout -b feat/add-retry-policy
git checkout -b fix/watcher-timeout
git checkout -b docs/update-yaml-guide
```

分支类型：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`

### 2. 编写代码 & 测试

- 新功能请添加对应的测试用例
- 确保所有测试通过：`pytest tests/ -v`
- 确保 lint 通过：`ruff check .`

### 3. 提交

Commit message 格式：`类型: 描述`

```
feat: 添加 xxx 功能
fix: 修复 xxx 问题
docs: 更新 xxx 文档
refactor: 重构 xxx 模块
test: 添加 xxx 测试
chore: 更新依赖 / 配置
```

### 4. 提交 Pull Request

- PR 标题简明扼要
- 描述中说明：**做了什么**、**为什么**、**如何测试**
- 确保 CI 通过

## Bug 报告

请在 [Issues](https://github.com/larrygogo/autopilot/issues) 中提交，包含：

- autopilot 版本（`autopilot --version`）
- Python 版本
- 操作系统
- 复现步骤
- 期望行为 vs 实际行为

## 功能建议

欢迎在 Issues 中提出，请说明：

- 使用场景
- 期望的行为
- 是否愿意自己实现

## 文档

文档使用中英双语维护（`docs/` + `docs/en/`）。如果你只熟悉一种语言，提交单语言的改动即可，我们会补充翻译。

## 版本发布（维护者）

### 发版步骤

```bash
# 1. 更新版本号
#    修改 core/__init__.py 中的 __version__

# 2. 更新 CHANGELOG.md
#    添加新版本条目，破坏性变更务必写在 Breaking Changes 章节

# 3. 提交
git add core/__init__.py CHANGELOG.md
git commit -m "chore: release v0.3.0"

# 4. 打 tag 并推送（CI 自动创建 GitHub Release）
git tag v0.3.0
git push origin main --tags
```

### 版本号规则

当前处于 `0.x` 阶段，采用语义化版本：

- **patch**（0.2.x）：Bug 修复，无破坏性变更
- **minor**（0.x.0）：新功能，**可能包含破坏性变更**
- `1.0` 之后：major 版本才允许破坏性变更

### 破坏性变更处理

在 CHANGELOG 中标注 `Breaking Changes` 章节，包含：

- 变更内容
- 影响范围
- 迁移步骤（数据库变更由 `autopilot upgrade` 自动处理，YAML/CLI 变更需手动说明）

## 许可证

提交代码即表示你同意将代码以 [MIT 许可证](LICENSE) 发布。
