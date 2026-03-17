# openclaw-dev-workflow

基于 OpenClaw 的 AI 驱动开发工作流框架。

从需求到 PR，全程自动化：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交。

## 特性

- **状态机驱动**：SQLite 持久化，非法状态转换编译期阻止
- **Push 模型**：每个阶段完成后直接触发下一步，无需轮询
- **Watcher 保底**：定期检测卡死任务，自动恢复
- **并发安全**：fcntl.flock 原子锁，防止竞态条件
- **可配置**：通过 config.yaml 适配任意项目和 OpenClaw 实例

## 状态机

```
pending_design → designing → pending_review → reviewing
    ↑ (驳回 < 10次，自动重试)       ↓通过
    └── review_rejected          developing → in_development → code_reviewing
                                     ↑ (驳回 < 10次，自动重试)       ↓通过
                                     └── code_rejected          pr_submitted
```

## 安装

```bash
git clone https://github.com/your-org/openclaw-dev-workflow
cd openclaw-dev-workflow
pip install -r requirements.txt
cp config.example.yaml config.yaml
# 编辑 config.yaml 填写实际配置
```

## 配置

参考 `config.example.yaml`，主要配置项：

- `reqgenie.base_url`：ReqGenie 实例地址
- `reqgenie.op_item`：1Password 条目名（存储 API Key）
- `notify.channel` / `notify.target`：通知渠道
- `agents.default`：各阶段使用的 AI agent
- `projects`：项目和仓库路径映射

## 使用

**注册并启动任务**：
```bash
python3 bin/start_task.py <req_id> --project my-project
```

**设置 cron（OpenClaw watcher，每 5 分钟）**：
```bash
openclaw cron add --name dev-workflow-watcher --every 5m \
  --system-event "python3 /path/to/openclaw-dev-workflow/bin/watcher.py"
```

## 依赖

- Python 3.10+
- [Claude Code CLI](https://claude.ai/code) 或 [Codex CLI](https://github.com/openai/codex)
- [1Password CLI (op)](https://1password.com/downloads/command-line/)
- [GitHub CLI (gh)](https://cli.github.com/)
- OpenClaw（用于通知和 cron 调度）

## 目录结构

```
bin/
  start_task.py     # 注册并启动任务
  run_phase.py      # 后台阶段执行入口
  watcher.py        # cron 异常恢复入口
src/dev_workflow/
  db.py             # SQLite 数据库和配置加载
  state_machine.py  # 状态机定义和转换
  runner.py         # 各阶段执行逻辑
  watcher.py        # 异常恢复逻辑
prompts/            # 各阶段 AI 提示词模板
```
