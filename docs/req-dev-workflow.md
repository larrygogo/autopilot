# req_dev Workflow 使用指南

`req_dev` 是 autopilot 替代旧 `dev` workflow 的新一代开发流程，专为「需求队列」工作模式设计。详见 [需求队列设计文档](./superpowers/specs/2026-05-06-requirement-queue-design.md)。

## 与 dev workflow 的差别

| | dev (旧) | req_dev (新) |
|---|----------|--------------|
| 仓库绑定 | workflow.yaml `config.repo_path`，全局单仓 | per-task `repo_id`，从 `repos` 表查 |
| setup 入参 | `{ title, requirement }` | `{ repo_id, title, requirement }` |
| 阶段（P1） | 5 阶段 | 5 阶段（design / review / develop / code_review / submit_pr） |
| 阶段（P3 后） | — | 7 阶段（额外 await_review / fix_revision，支持 PR 反馈循环） |
| 多仓库 | ❌（一个 workflow 一个仓库） | ✅（同 daemon 跑多仓库任务） |

## 前置准备

### 1. 注册仓库

在 Web UI `/repos` 页注册仓库（alias / path / default_branch / 可选 github_owner-repo）。

或用 REST：

```bash
curl -X POST http://127.0.0.1:6180/api/repos \
  -H "Content-Type: application/json" \
  -d '{"alias":"my-project","path":"/abs/path/to/project","default_branch":"main"}'
```

### 2. 健康检查

注册后点「健康检查」按钮，autopilot 会验证：
- 路径存在且是目录
- 是 git 仓库
- origin 远端可达（成功时自动从 origin URL 解析 GitHub owner/repo 回填）

### 3. gh CLI 登录

submit_pr 阶段会用 `gh pr create`，需提前 `gh auth login`。

## 启动方式

### CLI

```bash
autopilot task start --workflow req_dev --repo <alias> "标题" --requirement "需求描述..."
```

参数说明：
- `--workflow req_dev`（必填）
- `--repo <alias>`（req_dev 必填）
- 标题作为位置参数
- `--requirement "..."` 详细需求描述（多行可用 shell heredoc）

### REST

```bash
curl -X POST http://127.0.0.1:6180/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "workflow": "req_dev",
    "title": "加 GitHub Issues 集成",
    "requirement": "详细需求描述...",
    "repo_alias": "my-project"
  }'
```

或直接用 `repo_id`（跳过 alias 解析）：

```json
{
  "workflow": "req_dev",
  "title": "...",
  "requirement": "...",
  "repo_id": "repo-001"
}
```

## 阶段流程（P1）

```
design (architect agent 生成方案 plan.md)
  ↓
review (reviewer 评审方案；REJECT 回 design，PASS 进 develop)
  ↓
develop (developer agent 切分支 + 写代码 + commit)
  ↓
code_review (reviewer 审代码 diff；REJECT 回 develop，PASS 进 submit_pr)
  ↓
submit_pr (push 分支 + gh pr create/edit；写回 pr_url / pr_number 到 task extra)
```

每个阶段的产物保存在任务工作目录 `<task_workspace>/NN-<phase>/`：
- `00-design/plan.md` —— 实现方案
- `01-review/plan_review.md` —— 评审结论
- `03-code_review/code_review.md` —— 代码评审结论

可在 Web UI 任务详情页查看完整阶段日志。

## 后续 Phase（不在 P1）

- **P2**：需求池 + chat 集成（队列外澄清）
- **P3**：调度器 + await_review / fix_revision（同仓库串行 + PR 反馈循环）
- **P4**：gh CLI 轮询监听器（PR review 自动感知）

## 旧 dev workflow 退场

旧 `dev` workflow 从 P1 起停止使用。如果你的 `~/.autopilot/workflows/dev/` 含早期 Python 残留（`workflow.py`），可以清理：

```bash
rm -rf ~/.autopilot/workflows/dev/
```

旧 task 历史记录不受影响（task 表中的旧记录保留）。
