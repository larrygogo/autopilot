# 需求队列工作模式 使用指南

需求队列是 autopilot 替代旧 dev workflow 的新工作模式：你跟 chat agent 提需求 → 多轮澄清 → 用户确认入队 → autopilot 自动跑 req_dev workflow（设计 → 评审 → 开发 → 代码审查 → 提 PR）。

> **当前状态：4 phase + 子模块支持全闭环落地 🎉**
> - ✅ P1：仓库管理 + req_dev workflow（前 5 阶段）
> - ✅ P2：需求池 + chat 集成
> - ✅ P3：调度器（同仓库严格串行）+ await_review/fix_revision + 手动反馈触发回流
> - ✅ P4：gh CLI 轮询监听器（PR review change request 自动注入 + PR merge 自动检测）
> - ✅ P5：git submodule 支持（自动发现 + 跨父子 commit/PR + 父子组级调度锁）

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

## P3 工作流：同仓库串行 + PR 反馈循环

调度器（`src/daemon/requirement-scheduler.ts`）订阅 `requirement:status-changed` event-bus 事件，按 spec §6 规则：
- **每个 repo 同时只有 1 个「占用槽位」**（running ∨ fix_revision）
- **`awaiting_review` 不占槽位**（task 跑到 await_review 阶段后立即可释放给下一个 queued 需求）
- enqueue 仅置 status=queued；调度器响应事件创建 req_dev task

PR 反馈到达时：
1. `inject_feedback` REST / chat 工具记录反馈到 `requirement_feedbacks`
2. 如果 requirement 处于 `awaiting_review`，setStatus → `fix_revision`
3. `run_await_review` 阶段函数循环检测到状态变化，emit jump trigger `revision_request`
4. 状态机跳到 `fix_revision` 阶段，`run_fix_revision` 阶段函数读最新反馈 + 在原 PR 分支跑修改 + push
5. 跑完 emit `fix_done` jump 回 `await_review`，等待下一轮反馈或 merge

## 当前限制 / 已知边界

- ✅ 同仓库严格串行（调度器保证）
- ✅ PR review change request 自动注入反馈触发 fix_revision
- ✅ PR merge 自动 transition req → done
- ✅ git submodule 父子联动（详见下节）
- ⚠️ **gh CLI 必须本地已 `gh auth login`**：未登录时 pr-poller log warn 跳过，不影响其他模块
- ⚠️ **轮询间隔默认 5 min**：可在 `config.yaml.github.poll_interval_seconds` 调；最小 30s 保护 GitHub API rate limit
- ⚠️ **GitHub Issues / Jira 等外部需求源**：非本工作模式范围，留给后续扩展（详见 spec §15）

## P5：git submodule 支持

如果你的项目用了 git submodule（典型：父项目是前端 + 子模块是后端 / 共用库），autopilot 会把父 + 所有子模块视为**一组**，整个 req_dev 流程跨父子无缝跑通。

### 自动发现

注册父 repo 后点「健康检查」，autopilot 会：
1. 扫父 repo 根的 `.gitmodules`
2. 对每个子模块（仅 `github.com` 远端）自动登记成一条 `repos` 行（`parent_repo_id` 指向父）
3. alias 默认取子模块 name，冲突时加 `-2 / -3` 后缀
4. `default_branch` 优先取 `.gitmodules` 里的 `branch` 字段，缺省 `main`（subhgit-rs 等用 `master` 的需要登记后手动改 alias / branch）

子模块物理路径不存在 / URL 非 GitHub 时跳过 + 在 health 响应里给出 warning。

需要重新扫（用户后续加了子模块）时，在 `/repos` 父 repo 行点「重新发现子模块」按钮（`POST /api/repos/:id/rediscover-submodules`）。

### 列表展示

`/repos` 默认只列**父 repo**（`listRepos()` 默认过滤 `parent_repo_id IS NULL`）。点父 repo 行最左的展开按钮可看到下属子模块清单（路径 / 别名 / 默认分支 / GitHub）。

chat tool `list_repos` 同样只列父 repo —— 提需求时只能选父。给子模块 alias 调 `create_requirement_draft` 会被拒绝并提示父 alias。

### 跨父子提需求

正常用 chat 提（或 `/requirements` 新建），需求关联到父 repo。req_dev workflow 里：

1. **design**：`git submodule update --init --recursive` 拉齐子模块；agent prompt 列出本 repo 含哪些子模块、每个子模块的 GitHub owner/repo，让 agent 知道可改的代码路径
2. **develop**：父 + 各子模块都切 `feat/<title>` 分支；agent 在父 / 子任意路径写代码；扫每个子模块若有改动→子模块内 commit，最后父 repo `git add -A`（自动包含子模块 SHA bump）+ commit
3. **code_review**：父 diff + 各子模块 diff 拼起来给 reviewer agent
4. **submit_pr**：先 push + 开**子模块 PR**（每个有改动的子模块各开一个）→ 然后 push + 开**父 PR**；父 PR body 自动追加「关联子模块 PR」清单；子 PR 信息存到新表 `requirement_sub_prs`（一个需求对应 N 条子 PR）
5. **fix_revision**：基于父 PR 上的 review 反馈，agent 切回原分支跨父子改代码 + push 到原分支（不重开 PR）

### 调度策略：组级锁

父 + 所有子模块**同组共享一把调度锁**：

- 组内任一 repo 的 requirement 处于 `running` 或 `fix_revision` → 整组占满槽位，新需求要排队
- candidate 仅从**父 repo**拉 queued（chat 流程也保证只有父能被选）
- 不同组之间互不阻塞

避免「跨父子 task 并发改子模块」时的 git 冲突。

### Web UI 关联

- `/repos`：父 repo 行展开看子模块；点「重新发现子模块」（图标 GitBranch）触发同步
- `/requirements/:id`：Meta 卡下方「关联子模块 PR」列表（每条点击外链跳 GitHub）

### 仅支持的范围（P5）

- ✅ 一层子模块（嵌套子模块不支持）
- ✅ `github.com` 远端
- ✅ 子模块默认分支跟父不同（子用 master、父用 main）
- ❌ 子模块 PR review 自动监听（pr-poller 仅盯父 PR；子 PR 用户在 GitHub 自行 review/merge）
- ❌ pnpm/yarn workspace 子包关联（同 repo 内多 package，已能正常 work，不需要特殊处理）
- ❌ GitLab / Bitbucket 等非 GitHub submodule

## 后续扩展（不在 4 phase + P5 范围）

完整 4 phase + P5 子模块支持已落地。后续可能的扩展（详见 spec §15）：

- 外部需求源接入器（GitHub Issues / 飞书任务 / Jira）
- 需求模板 / 类型（feat / fix / chore）
- 队列优先级 + 拖拽重排
- 跨需求依赖（"req-002 等 req-001 完成"）
- PR webhook 替代轮询（实时性更好但需公网 daemon）
- 多人协作（需求归属 / review 分配）

## 相关文档

- [req_dev workflow 使用指南](./req-dev-workflow.md)
- [需求队列设计文档](./superpowers/specs/2026-05-06-requirement-queue-design.md)
- [git submodule 支持 设计文档（P5）](./superpowers/specs/2026-05-07-submodule-support-design.md)
- [P1 实施计划](./superpowers/plans/2026-05-06-requirement-queue-phase1.md)
- [P2 实施计划](./superpowers/plans/2026-05-06-requirement-queue-phase2.md)
- [P5.1–5.3 实施计划](./superpowers/plans/)
