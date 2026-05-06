[中文](quickstart.md) | [English](en/quickstart.md)

## 为什么用 autopilot

LLM agent 单次调用很厉害，但**真实工作很少是单次的**：要写完代码自己跑测试、出方案先给你看再开干、中途遇到岔路停下来问你、出错回到上一步重做。这不是 agent 能力问题，是**编排层**问题。autopilot 把"agent 调用"作为一等公民，配上状态机、人在中间、可视化和本地持久化——单进程 daemon + SQLite + 自带 Web，照着下面跑完，你就有了一个能改、能审、能复盘的 agent 流水线。

## 5 分钟你能跑出什么

跑通后你会得到一个**自带的 `dev` 工作流**，下次提需求只要 `autopilot task start` 一句话：

```
你：给我加个任务标签功能
  ↓
architect agent 读 repo + 写技术方案 → workspace/00-design/plan.md
  ↓
[Gate: 你审方案] ← 通过则继续，驳回带理由回上一步
  ↓
developer agent 写代码 + 跑测试 + git commit
  ↓
reviewer agent 看 diff 评审 → REVIEW_RESULT: PASS/REJECT
  ↓
gh pr create  ← 真的提 PR
```

每步产物自动归档到 task workspace，Web UI 实时看进度、看日志、按驳回。

---

# 5 分钟快速入门

本教程带你从零开始，5 分钟内跑通第一个 autopilot 任务。

**前置条件**：Python 3.10+、Git

---

## 第一部分：3 分钟看到结果

### 步骤 1：安装（30s）

```bash
git clone https://github.com/larrygogo/autopilot && cd autopilot
pip install -e ".[dev]"
```

### 步骤 2：初始化工作空间（10s）

```bash
autopilot init
autopilot upgrade
```

预期输出：

```
✓ 已创建 ~/.autopilot/
✓ 已创建 ~/.autopilot/workflows/
✓ 已创建 ~/.autopilot/runtime/
✓ 初始化完成
```

### 步骤 3：查看可用工作流（10s）

```bash
autopilot workflows
```

预期输出（如果已将示例工作流复制到 `~/.autopilot/workflows/`）：

```
已注册工作流：
  dev          [AI] 完整开发流程（设计 → 评审 → 开发 → 代码审查 → PR）
  req_review   [AI] 需求评审流程（需求分析 → 需求评审）
  doc_gen      文档生成与评审
```

> **提示**：框架自动扫描 `~/.autopilot/workflows/` 目录。如果列表为空，先将示例工作流复制过去：
> ```bash
> cp -r examples/workflows/* ~/.autopilot/workflows/
> ```

### 步骤 4：启动一个任务（10s）

使用 `doc_gen`（最简单的 2 阶段工作流）启动任务：

```bash
autopilot start DOC-001 --workflow doc_gen
```

预期输出：

```
2026-01-15 10:30:00 [INFO] [GENERATE] 任务 DOC-001 已创建，工作流: doc_gen
2026-01-15 10:30:00 [INFO] [GENERATE] 开始执行阶段: generate
```

### 步骤 5：查看任务状态（10s）

```bash
# 查看单个任务详情
autopilot show DOC-001

# 查看所有任务
autopilot list
```

`show` 预期输出：

```
任务: DOC-001
工作流: doc_gen
状态: pending_generate
创建时间: 2026-01-15 10:30:00
```

`list` 预期输出：

```
ID        工作流      状态               创建时间
DOC-001   doc_gen    pending_generate   2026-01-15 10:30:00
```

### 步骤 6：打开 WebUI 管理界面（30s）

安装 WebUI 插件并启动：

```bash
pip install -e examples/plugins/autopilot-webui
autopilot webui
```

打开浏览器访问 `http://127.0.0.1:8080`，你将看到：

- **仪表盘**：任务统计、成功率、状态分布图
- **任务列表**：筛选、查看详情、流转日志时间线
- **工作流列表**：卡片式展示所有已注册工作流

<!-- TODO: 补充 WebUI 截图
![WebUI 仪表盘](screenshots/webui-dashboard.png)
-->

### 步骤 7：查看统计（10s）

```bash
autopilot stats
```

预期输出：

```
任务统计：
  总数: 1
  活跃: 1
  完成: 0
  取消: 0
```

---

## 第二部分：2 分钟自定义工作流（可选）

创建一个最简单的自定义工作流，验证整个流程。

### 1. 创建工作流目录

```bash
mkdir -p ~/.autopilot/workflows/hello
```

### 2. 编写 workflow.yaml

```bash
cat > ~/.autopilot/workflows/hello/workflow.yaml << 'EOF'
name: hello
description: Hello World 示例工作流

phases:
  - name: greet
    timeout: 60

  - name: farewell
    timeout: 60
EOF
```

只需定义 `name` 和 `timeout`，其余状态（`pending_greet`、`running_greet` 等）全部**自动推导**。

### 3. 编写 workflow.py

```bash
cat > ~/.autopilot/workflows/hello/workflow.py << 'EOF'
from core.state_machine import transition
from core.runner import run_in_background

def run_greet(task_id: str) -> None:
    print(f"[hello] 你好，任务 {task_id}！开始处理...")
    transition(task_id, "greet_complete")
    run_in_background(task_id, "farewell")

def run_farewell(task_id: str) -> None:
    print(f"[hello] 任务 {task_id} 处理完毕，再见！")
    transition(task_id, "farewell_complete")
EOF
```

### 4. 验证并运行

```bash
# 校验工作流定义
autopilot validate hello

# 查看已注册工作流（应包含 hello）
autopilot workflows

# 启动任务
autopilot start HELLO-001 --workflow hello

# 查看结果
autopilot show HELLO-001
```

预期输出：

```
任务: HELLO-001
工作流: hello
状态: done
创建时间: 2026-01-15 10:35:00
```

恭喜！你已经成功创建并运行了自定义工作流。

---

## 5 分钟跑通需求队列

需求队列是 autopilot 替代旧 dev workflow 的新工作模式（详见 [需求队列指南](./requirement-queue.md)）。

1. 启动 daemon：`autopilot daemon start`
2. 打开 Web UI：`autopilot dashboard`
3. 在 `/repos` 注册一个仓库 + 健康检查（必须有 GitHub origin，submit_pr 阶段会用 gh CLI 提 PR）
4. **方式一（chat 推荐）**：在 `/chat` 跟 agent 说「我有个新需求 — ...」
5. **方式二（手动）**：在 `/requirements` 点「新建需求」→ 编辑 spec → 标记为已澄清 → 入队执行
6. 在 `/tasks` 看 task 跑到 submit_pr → GitHub 上看 PR 已创建

P2 当前限制和后续 Phase 路线图见 [需求队列指南](./requirement-queue.md)。

---

## 下一步

| 想了解... | 阅读 |
|-----------|------|
| 工作流的完整定义语法 | [工作流开发指南](workflow-development.md) |
| 框架内部架构和设计决策 | [架构总览](architecture.md) |
| 状态机和驳回机制 | [状态机详解](state-machine.md) |
| 如何开发第三方插件 | [插件开发指南](plugin-development.md) |
| 常见问题和故障排查 | [FAQ](faq.md) |
