# 需求队列工作模式 使用指南

需求队列是 autopilot 替代旧 dev workflow 的新工作模式：你跟 chat agent 提需求 → 多轮澄清 → 用户确认入队 → autopilot 自动跑 req_dev workflow（设计 → 评审 → 开发 → 代码审查 → 提 PR）。

> **当前状态：Phase 2 落地**
> - ✅ P1：仓库管理 + req_dev workflow（前 5 阶段）
> - ✅ P2：需求池 + chat 集成 + 临时降级 enqueue 直接创建 task
> - ⏳ P3：调度器 + await_review/fix_revision + PR 反馈循环
> - ⏳ P4：gh CLI 轮询监听器（PR review 自动感知）

## 流程概述

```
[chat 提需求] → drafting → clarifying（多轮澄清）→ ready
   ↓ 用户确认入队
queued → running（req_dev task 跑起来）→ submit_pr 完成
```

每个需求一条状态线，跨 phase 演进；P3 起会扩展 awaiting_review / fix_revision 状态。

## 前置准备

1. 仓库已在 Web UI `/repos` 注册 + 健康检查通过（[req_dev workflow 指南](./req-dev-workflow.md)）
2. `gh auth login` 已登录（submit_pr 阶段提 PR 用）
3. autopilot daemon 启动中

## 用法

### 方式 A：跟 chat 提需求（推荐）

打开 Web UI `/chat`，对 agent 说类似：

```
我有个新需求 — 在 autopilot 仓库的 README 末尾加一段「关于」介绍
```

agent 应当：
1. 调 `list_repos` 看你有哪些仓库
2. 询问选哪个仓库
3. 调 `create_requirement_draft` 创建草稿
4. 多轮追问（验收标准、约束、参考实现）
5. 调 `update_requirement_spec` 写入完整规约
6. 等你说「OK 入队」
7. 调 `mark_requirement_ready` + `enqueue_requirement`
8. 报告新创建的 task_id 和 PR 进度入口

`enqueue_requirement` 完成后会立即创建一个 req_dev task（P3 调度器接管前的临时实现）。

### 方式 B：直接在 Web UI 操作

1. 进 `/requirements` 点「新建需求」
2. 选仓库 + 填标题 → 进入详情页（草稿状态）
3. 在详情页编辑 spec_md（粘贴 / 手写完整规约）
4. 点「标记为已澄清」（status → ready）
5. 点「入队执行」（status → running，触发 task）
6. 进 `/tasks` 看 task 跑通

### 方式 C：REST API（自动化用）

```bash
# 创建草稿
curl -X POST http://127.0.0.1:6180/api/requirements \
  -H "Content-Type: application/json" \
  -d '{"repo_id":"repo-001","title":"加 README 段落","spec_md":"详细需求..."}'
# → { requirement: { id: "req-001", status: "drafting", ... } }

# 转 ready（草稿完整时）
curl -X POST http://127.0.0.1:6180/api/requirements/req-001/transition \
  -H "Content-Type: application/json" -d '{"to":"ready"}'

# 入队（创建 req_dev task）
curl -X POST http://127.0.0.1:6180/api/requirements/req-001/enqueue
# → { requirement: {... status: "running" ...}, task_id: "abc123" }

# 看 task 进度
curl http://127.0.0.1:6180/api/tasks/abc123
```

## 状态枚举

| 状态 | 含义 |
|------|------|
| `drafting` | 刚创建，还在多轮澄清 |
| `clarifying` | 已经写过 spec_md 但还在调整 |
| `ready` | spec_md 完成，等用户点入队 |
| `queued` | 已入队，等调度器拉走（P3 之前是过渡状态） |
| `running` | 调度器拉走，task 跑到 await_review 之前 |
| `awaiting_review` | task 跑到 await_review 阶段（P3 后才有，不占槽位） |
| `fix_revision` | 接到 review 反馈，task 转入修复（P3 后才有，占槽位） |
| `done` | PR merged |
| `cancelled` | 用户主动取消 |
| `failed` | 多次重试仍失败的兜底状态 |

## 反馈历史

`/requirements/:id` 详情页的「反馈历史」时间线展示所有手动注入的反馈。

P3 起，PR review 收到 change request 时会自动注入 github_review 类型反馈，触发 fix_revision 阶段；P2 当前仅记录，不触发。

## P2 当前限制

- ✅ 同仓库可以入队多个需求，但**没有调度器**：每个 enqueue 立即创建 task；多个 task 会**并发跑**（不等前一个的 PR）。这跟 spec §A1「同仓库严格串行」**不一致**——P3 调度器才会强制串行。当前 P2 阶段建议一次只入队一个，等其 PR 完成再入下一个。
- ✅ 没有 PR 反馈循环：PR review change request 不会自动触发修复；需要手动注入反馈（仅记录，不重跑 develop）。
- ✅ 没有 GitHub 监听：PR merge / review 状态需要你自己看。

完整闭环（同仓库串行 + 自动反馈循环 + GitHub 监听）由 P3 / P4 落地。

## 后续 Phase

- **P3**：调度器（同仓库串行）+ await_review / fix_revision 阶段函数 + 手动反馈触发回流
- **P4**：gh CLI 轮询监听器（PR review 自动感知）

## 相关文档

- [req_dev workflow 使用指南](./req-dev-workflow.md)
- [需求队列设计文档](./superpowers/specs/2026-05-06-requirement-queue-design.md)
- [P1 实施计划](./superpowers/plans/2026-05-06-requirement-queue-phase1.md)
- [P2 实施计划](./superpowers/plans/2026-05-06-requirement-queue-phase2.md)
