# 需求队列工作模式 设计文档

| | |
|---|---|
| 状态 | Draft |
| 日期 | 2026-05-06 |
| 作者 | larry |

## 1. 背景与目标

### 1.1 现状
- 现有 `dev` workflow（design → review → develop → code_review → submit_pr）只支持「全局单仓库」（`config.repo_path` 全局变量），不能在同一 daemon 里给多仓库分别跑任务
- 用户家目录的 `dev` workflow 还停留在早期 Python 残留（`workflow.py`），新 TS+YAML 体系下加载失败
- 没有「需求」一级实体：每次开任务都是裸 task，没有「需求池 → 排队 → 执行 → PR 反馈循环」的连贯生命周期

### 1.2 目标
建立一种新工作模式：

1. **多需求队列（手动来源）**：用户在 chat 里提需求 → agent 多轮澄清 → 用户确认入队 → autopilot 自动顺序执行
2. **同仓库严格串行**：避免 git 分支 / working tree 冲突
3. **跨仓库并行**：每个仓库独立串行队列
4. **PR 反馈循环**：提 PR 后立即开始下一个；review 反馈到 → 暂停下一个 → 原任务回退到 develop 修复 → push 同 PR 分支
5. **GitHub 集成**：通过本地 `gh` CLI 轮询获取 PR review 状态

### 1.3 非目标
- ❌ 外部需求系统接入（GitHub Issues / Jira / 飞书任务）—— 留给后续迭代
- ❌ 多人协作（仅单用户本地 daemon）
- ❌ 复杂队列管理（优先级 / 拖拽重排 / 批量操作）—— 起步只支持「FIFO + 取消」

## 2. 关键决策（已经过澄清）

| 维度 | 决策 | 原因 |
|------|------|------|
| 同仓库并发 | 严格串行 | 避免 git 冲突，最稳的工作模式 |
| 需求来源 | 仅手动（chat 入口） | 先把核心闭环跑通；外部系统接入留给以后 |
| PR 后语义 | 提交即转「awaiting_review」中间态，**不占槽位**，自动开下一个 | 用户原话「无需等待，直接下一个」；同时保留 PR 状态可见性 |
| PR 反馈处理 | 主用「重开原 task」(b) + 辅 chat 直改 (d) | 一个需求一条线最清晰，可追溯多轮修复历史 |
| 反馈期间下一个 | 自动暂停（`fix_revision` 占槽位） | 同仓库串行下，PR 修复必须能抢占队列 |
| PR 反馈感知 | gh CLI 轮询（默认 5min）+ 手动注入兜底 | 零运维;gh 复用用户已有认证 |
| 澄清环节 | 队列外（需求池 / 执行队列分离） | 澄清是异步思考过程，不该占用执行槽位 |
| 澄清交互 | chat 入口 + 需求池看板 | 复用现有 chat 接入；草稿可视化 |
| 工作流 | 新建 `req_dev`，旧 workflow 退场 | 单一职责；旧 dev 已是空壳，没历史包袱 |
| 仓库管理 | Web UI + DB + 健康检查 | 多仓库使用频次高，CRUD UI 必要 |
| 实施节奏 | 4 phase 分阶段交付 | 每 phase 独立可发布、可回滚 |

## 3. 数据模型

### 3.1 `repos`：仓库目录

```sql
CREATE TABLE repos (
  id TEXT PRIMARY KEY,                  -- 自动生成，e.g. "repo-001"
  alias TEXT NOT NULL UNIQUE,           -- 用户起的短名，用于 chat 引用
  path TEXT NOT NULL,                   -- 绝对路径
  default_branch TEXT NOT NULL DEFAULT 'main',
  github_owner TEXT,                    -- 可选：从 git remote 自动解析
  github_repo TEXT,                     -- 可选：同上
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

健康检查（按需触发，不存 DB）：
- `path` 存在且是目录
- `git -C path rev-parse --is-inside-work-tree` 返回 true
- `git -C path remote get-url origin` 成功
- 返回 `{ healthy: bool, issues: string[] }`

所有外部命令统一通过 `Bun.spawn` 走 `argv` 数组，**不拼接 shell 字符串**，避免命令注入。

### 3.2 `requirements`：需求实体

```sql
CREATE TABLE requirements (
  id TEXT PRIMARY KEY,                  -- e.g. "req-001"
  repo_id TEXT NOT NULL REFERENCES repos(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,                 -- 见状态枚举
  spec_md TEXT NOT NULL DEFAULT '',     -- 澄清产出的需求规约
  chat_session_id TEXT,                 -- 关联到主 chat 的会话标识
  task_id TEXT,                         -- 当前执行 task（running / awaiting_review / fix_revision 时非空）
  pr_url TEXT,                          -- 提 PR 后填充
  pr_number INTEGER,                    -- 同上，gh 轮询要用
  last_reviewed_event_id TEXT,          -- gh 轮询去重用
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**状态枚举**（10 种）：
```
drafting          ── 刚创建，还在多轮澄清
clarifying        ── 已经写过 spec_md 但还在调整
ready             ── spec_md 完成，等用户点入队
queued            ── 已入队，等调度器拉走
running           ── 调度器拉走，task 跑到 await_review 之前
awaiting_review   ── task 跑到 await_review 阶段（不占槽位）
fix_revision      ── 接到 review 反馈，task 转入 fix_revision 阶段（占槽位）
done              ── PR merged
cancelled         ── 用户主动取消
failed            ── 多次重试仍失败的兜底状态
```

> 不引入 `archived` 状态：完成后的需求停留在 `done` 即可，UI 上用「隐藏已完成」筛选；想彻底清理的需求走 `cancelled`。简化状态机。

### 3.3 `requirement_feedbacks`：PR 反馈历史

```sql
CREATE TABLE requirement_feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  source TEXT NOT NULL,                 -- 'github_review' | 'manual'
  body TEXT NOT NULL,                   -- review 文本 / 用户在 chat 注入的内容
  github_review_id TEXT,                -- 仅 source=github_review 时填，去重用
  created_at INTEGER NOT NULL
);
```

每次注入反馈追加一条；req_dev 的 `fix_revision` 阶段会读取最近一条 / 全部未消费记录作为输入。

### 3.4 现有 `tasks` 表
**不改 schema**。需求与 task 通过 `requirements.task_id` 单向引用，task 不需要反向感知 requirement。

## 4. req_dev workflow 定义

`examples/workflows/req_dev/workflow.yaml`：

```yaml
name: req_dev
description: "需求驱动的开发流程（设计 → 评审 → 开发 → 代码审查 → PR → review 等待 → 反馈修复）"
setup_func: setup_req_dev_task

agents:
  - name: architect
    provider: anthropic
    model: claude-sonnet-4-6
    permission_mode: bypassPermissions
  - name: developer
    provider: anthropic
    model: claude-opus-4-6
    permission_mode: bypassPermissions
  - name: reviewer
    provider: anthropic
    model: claude-sonnet-4-6
    permission_mode: bypassPermissions

phases:
  - name: design
    agent: architect
    timeout: 900
  - name: review
    agent: reviewer
    timeout: 900
    reject: design
    max_rejections: 10
  - name: develop
    agent: developer
    timeout: 1800
  - name: code_review
    agent: reviewer
    timeout: 1200
    reject: develop
    max_rejections: 10
  - name: submit_pr
    timeout: 300

  # await_review：长挂起态，靠外部 trigger 推进
  # - revision_request：review 反馈到达 → 跳到 fix_revision
  # - merged：PR 已 merged → 任务终结（jump 到一个虚拟 done 阶段，或直接 force_transition 到终态）
  - name: await_review
    timeout: 2592000           # 30 天兜底
    jump_trigger: revision_request
    jump_target: fix_revision

  # fix_revision：独立阶段，agent 在此读 feedback + checkout PR 分支 + 修复 + push
  # 完成后 jump 回 await_review 等待下一轮
  - name: fix_revision
    agent: developer
    timeout: 1800
    jump_trigger: fix_done
    jump_target: await_review
    max_rejections: 30
```

> 注意 `fix_revision` 不再用 `reject: develop` —— 它是一个独立阶段，专门负责「读反馈 + 修代码 + 推 PR 分支」，不复用 develop 阶段函数（避免 develop 还要分支管理）。yaml 里 `jump_trigger: fix_done` 由阶段函数末尾 emit。

### 4.1 await_review 阶段函数实现要点

`await_review` 是 autopilot 中第一个「永久挂起靠外部 trigger 推进」的阶段。实现要点：

```ts
export async function run_await_review(taskId: string): Promise<void> {
  // 立即把 requirement 状态同步为 awaiting_review，调度器据此拉下一个需求
  const reqId = readTaskField(taskId, "requirement_id");
  setRequirementStatus(reqId, "awaiting_review");

  // 进入挂起循环：每 N 秒醒来检查一次 requirement.status
  // - status === 'fix_revision' → emit("revision_request") 让状态机跳到 fix_revision，函数返回
  // - status === 'done'         → force_transition 到终态，函数返回
  // - 其他              → 继续 sleep
  while (true) {
    const status = getRequirementStatus(reqId);
    if (status === "fix_revision") {
      emitTrigger(taskId, "revision_request");
      return;
    }
    if (status === "done") {
      forceTransition(taskId, "done");
      return;
    }
    await Bun.sleep(15_000);
  }
}
```

**Watcher 适配**：现有 watcher 把长时间停滞在 `running_*` 的任务标 dangling。`await_review` 阶段需要在 watcher 检测里加白名单 —— 看到 `running_await_review` 不算 dangling。

**daemon 重启**：daemon 重启后阶段函数从头跑（autopilot 现有 push 模型），await_review 重新进入挂起循环；外部状态由 requirement.status 持久保存，循环条件不丢失。

`setup_req_dev_task` 接收：
```ts
type Args = {
  requirement_id: string;   // 必填，关联到 requirement
  // 以下从 requirement / repo 自动派生，不需要外部传：
  // repo_path / default_branch / branch / requirement_md / pr_number
};
```

## 5. 关键交互流程

### 5.1 需求创建到入队

```
[用户在 chat] "我有个新需求：autopilot 加 GitHub Issues 集成"
    ↓
[chat agent] 调 create_requirement_draft({ repo_id: "autopilot", title, initial_text })
    ↓ requirement.status = drafting，返回 req_id
[chat agent] 多轮澄清提问（用户回答）
    ↓
[chat agent] 调 update_requirement_spec({ req_id, spec_md })
    ↓ requirement.status = clarifying
[用户] "OK，没问题，入队吧"
    ↓
[chat agent] 调 mark_requirement_ready({ req_id })
    ↓ status = ready
[用户] 在 Web UI /requirements/:id 点「入队」按钮（或在 chat 让 agent 调 enqueue_requirement）
    ↓ status = queued
[调度器] 拉走，创建 req_dev task
    ↓ status = running
```

### 5.2 PR 提交后流转

```
[req_dev task] 跑到 submit_pr 阶段，gh pr create
    ↓ requirement.pr_url, pr_number 写入
[task] 转入 await_review 阶段，长时间挂起
    ↓ requirement.status = awaiting_review
[调度器] 看到该 repo 没有 running / fix_revision 状态需求，拉下一个 queued
    ↓
（PR 在 GitHub 等待 review）
```

### 5.3 review 反馈到达

```
[pr-poller] 周期扫所有 awaiting_review 需求的 PR
  → Bun.spawn(["gh", "pr", "view", String(pr_number), "--json", "reviews,state,mergeCommit", "-R", `${owner}/${repo}`])
  → 对比 last_reviewed_event_id，发现新 CHANGES_REQUESTED review
    ↓
[pr-poller] 调内部 inject_feedback({ req_id, source: 'github_review', body, github_review_id })
    ↓ 写 requirement_feedbacks 一条；setRequirementStatus(req_id, 'fix_revision')
    ↓
[await_review 阶段函数] 下一轮 sleep 醒来 → 检测到 status='fix_revision' → emitTrigger(task, 'revision_request') → 函数返回
    ↓ 状态机跳到 fix_revision 阶段
[fix_revision 阶段函数]
    ↓ 读 requirement_feedbacks 最新条作为输入
    ↓ checkout 原 PR 分支，跑 developer agent 修复
    ↓ git push origin <branch>（push 到原 PR）
    ↓ 末尾 emitTrigger(task, 'fix_done') → 跳回 await_review
    ↓ await_review 阶段函数重新被调用，setRequirementStatus(req_id, 'awaiting_review')
[调度器] 看到该 repo 重新只有 awaiting_review（不占槽位），继续拉下一个 queued
```

### 5.4 PR merged

```
[pr-poller] 发现 PR state = MERGED
    ↓
[pr-poller] 调 mark_done(req_id)
    ↓ setRequirementStatus(req_id, 'done')
[await_review 阶段函数] 下一轮 sleep 醒来 → 检测到 status='done' → forceTransition(task, 'done') → 函数返回
    ↓ task 终态 done
```

## 6. 调度器（scheduler）规则

`src/daemon/requirement-scheduler.ts` —— 监听 event-bus 上 requirement.status 变化，重新计算每个 repo 的队列。

**核心算法**：每次 requirement 状态变化或新需求入队时，按 repo 分组扫描：

```
对每个 repo R：
  active = R 下所有 status ∈ {running, fix_revision} 的 requirements
  if active 非空:
    do nothing  # 该 repo 队列被占用
    continue

  candidate = R 下所有 status = queued 的 requirements，按 created_at 升序，取第一个
  if candidate 不存在:
    continue

  # 拉走候选
  task_id = create_task("req_dev", { requirement_id: candidate.id })
  candidate.task_id = task_id
  candidate.status = running
```

**关键不变量**：
- `status ∈ {running, fix_revision}` 在同一 repo 下**最多 1 个**
- `status = awaiting_review` 不计入「占用」，可以与 running / fix_revision **共存**（但只有当当前 running / fix_revision 走完才会有新的 running 加入）
- 等价地：「进行中」 = `running ∨ fix_revision`，「待审中」 = `awaiting_review`，二者互不阻塞

**触发时机**：通过现有 event-bus 订阅 `task:transition` 和 `requirement:status-changed` 事件；每次都调 `tickRepo(repo_id)` 重算。

## 7. PR 轮询监听器（pr-poller）

`src/daemon/pr-poller.ts` —— 通过现有 scheduler 周期触发（默认 5 min）。

**配置**：
```yaml
github:
  cli: gh                     # 默认 'gh'，留出可覆盖（比如自编译路径）
  poll_interval_seconds: 300  # 默认 5 min
```

**逻辑**（伪代码，**所有外部命令统一走 `Bun.spawn` argv 数组**，不拼接 shell 字符串）：

```typescript
async function pollAllPRs(): Promise<void> {
  const reqs = listRequirements({ status: 'awaiting_review' });
  for (const req of reqs) {
    if (!req.pr_number) continue;
    const repo = getRepo(req.repo_id);
    if (!repo.github_owner || !repo.github_repo) continue;

    try {
      // 关键：用 argv 数组传参，不允许 shell 解释
      const proc = Bun.spawn(
        [cliPath, "pr", "view", String(req.pr_number),
         "--json", "reviews,state,mergeCommit",
         "-R", `${repo.github_owner}/${repo.github_repo}`],
        { stdout: "pipe", stderr: "pipe" }
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) throw new Error(await new Response(proc.stderr).text());
      const data = JSON.parse(await new Response(proc.stdout).text());

      // 检查 merged
      if (data.state === 'MERGED' || data.mergeCommit) {
        markDone(req.id);
        continue;
      }

      // 检查新 CHANGES_REQUESTED reviews
      const newReviews = data.reviews.filter((r: GhReview) =>
        r.state === 'CHANGES_REQUESTED'
        && (!req.last_reviewed_event_id || r.id > req.last_reviewed_event_id)
      );
      if (newReviews.length > 0) {
        const body = newReviews.map(r => `## ${r.author.login}\n${r.body}`).join('\n\n');
        const lastId = newReviews[newReviews.length - 1].id;
        injectFeedback({
          requirement_id: req.id,
          source: 'github_review',
          body,
          github_review_id: lastId,
        });
        updateRequirement(req.id, { last_reviewed_event_id: lastId });
      }
    } catch (e) {
      log.warn(`PR poll failed for req=${req.id}: ${(e as Error).message}`);
      // 不更新 last_reviewed_event_id，下个周期重试
    }
  }
}
```

**与手动注入兼容**：`injectFeedback()` 是统一入口；REST `POST /api/requirements/:id/inject_feedback` 和 chat 工具 `inject_feedback` 都调它。

## 8. Chat 集成（agent 工具）

新增工具：

| 工具 | 入参 | 行为 |
|------|------|------|
| `list_repos` | — | 返回所有 repos（alias / path） |
| `create_requirement_draft` | `{ repo_alias, title, initial_text? }` | 新建 requirement，status=drafting，返回 id |
| `update_requirement_spec` | `{ req_id, spec_md }` | 写入完整规约，status=clarifying |
| `mark_requirement_ready` | `{ req_id }` | clarifying → ready |
| `enqueue_requirement` | `{ req_id }` | ready → queued |
| `list_requirements` | `{ repo_alias?, status? }` | 看草稿池 / 执行状态 |
| `inject_feedback` | `{ req_id, body }` | 手动注入 review 反馈，触发 fix_revision |
| `cancel_requirement` | `{ req_id }` | 任意状态 → cancelled |

**chat agent system prompt 增加部分**：
- 引导用户走「先选仓库 → 多轮澄清 → 写入规约 → 用户确认入队」节奏
- 维护当前会话的 active requirement_id（避免多需求混淆）

## 9. Web UI 新页面

### 9.1 `/repos`
- 仓库列表：alias / path / 健康标签 / 操作（编辑 / 删除 / 健康检查）
- 「新建仓库」按钮 → 表单（alias、path、default_branch、可选 github_owner/repo）
- 健康检查异步触发，显示 spinner

### 9.2 `/requirements`（需求池看板）
- Tab 分组：草稿（drafting / clarifying）/ 已澄清（ready）/ 执行中（queued / running / awaiting_review / fix_revision）/ 完成（done / cancelled / failed）
- 每行：title / repo alias / 状态徽标 / PR 链接（如有）/ 关联 task 链接
- 点击进 `/requirements/:id`

### 9.3 `/requirements/:id`
- 顶部：title / repo / 状态 / PR 链接
- 主体：
  - spec_md 渲染（可编辑）
  - 「关联 chat 会话」入口（跳转到 chat）
  - 「入队」按钮（仅 ready 时显示）
  - 「取消」按钮
  - 「注入反馈」表单（仅 awaiting_review 时显示）
- 反馈历史：`requirement_feedbacks` 时间线展示
- 关联 task：跳转到 `/tasks/:task_id` 看阶段日志

### 9.4 `/tasks` 现有页改动
- task 行增加「关联需求」字段（如有）：跳转到 `/requirements/:id`

## 10. 错误处理

| 场景 | 处理 |
|------|------|
| repo path 失效（被删 / 改名）| 健康检查标红；新需求入队前 enqueue 校验，不通过则报错 |
| github_owner/repo 推断失败 | 仓库表手动填，用户在 UI 提示中改 |
| gh CLI 未登录 | pr-poller 跳过 + warn，不影响其他模块；UI 在「设置」页提示 `gh auth login` |
| gh CLI rate limit | 重试退避；连续失败标 task 为 failed 让用户人工介入 |
| daemon 重启后 task 处于 awaiting_review | 状态机 dangling 检测：`status=awaiting_review` 排除在 dangling 之外（不算卡死），daemon 重启正常恢复 |
| fix_revision 阶段崩溃 | 走现有 task failure 路径；用户可在 UI 重试 |
| 需求被取消但 task 已在跑 | 触发 task 的 cancel；PR 留在 GitHub 等用户手工处理 |
| 同 repo 多个 fix_revision 同时被触发 | 不可能（不变量保证 running ∨ fix_revision 互斥）；若发生说明状态机 bug |

## 11. 测试策略

### 11.1 单元测试
- `requirement-scheduler.tickRepo()`：构造各种 status 组合，验证拉新逻辑
- `pr-poller.diffReviews()`：mock gh 输出，验证去重 / 反馈识别
- `inject_feedback()`：验证状态切换 + feedback 落库

### 11.2 e2e 测试（每 phase 至少一个）
- **P1**：通过 REST 创建 repo → 创建 req_dev task → 跑通到 submit_pr（mock gh / mock agent）
- **P2**：chat 调 create_requirement_draft → update_spec → enqueue → 触发 task
- **P3**：同 repo 入队 3 个需求 → 验证「await_review 不阻塞，fix_revision 阻塞」
- **P4**：mock gh 输出 CHANGES_REQUESTED → 验证自动 inject_feedback

## 12. 分阶段交付

### Phase 1：仓库管理 + req_dev workflow（per-task repo）
**产出**：
- DB migration: `repos` 表
- REST: `GET / POST / PUT / DELETE /api/repos`、`POST /api/repos/:id/healthcheck`
- Web UI: `/repos`
- workflow: `examples/workflows/req_dev/{workflow.yaml, workflow.ts}`，**仅前 5 阶段**（design → review → develop → code_review → submit_pr）
- 清理旧 dev：删除 `~/.autopilot/workflows/dev/workflow.py` 残留 + 文档说明

**验收**：
- `/repos` UI 能 CRUD + 健康检查
- `autopilot task start --workflow req_dev --repo <alias> --title <t> --requirement <r>` 跑通到 submit_pr

### Phase 2：需求池 + chat 集成
**产出**：
- DB migration: `requirements` 表 + `requirement_feedbacks` 表
- REST: `GET / POST / PUT / DELETE /api/requirements`、`POST /api/requirements/:id/enqueue`、`POST /api/requirements/:id/inject_feedback`、`POST /api/requirements/:id/cancel`
- Chat tools（全部 8 个，见第 8 节）
- Web UI: `/requirements` 列表 + `/requirements/:id` 详情
- **过渡降级**：`enqueue` 调用直接创建 req_dev task（无队列约束），等 P3 调度器接手

**验收**：
- chat 多轮澄清 → 写规约 → mark_ready → enqueue → 看到 req_dev task 启动

### Phase 3：调度器 + await_review/fix_revision + 手动注入
**产出**：
- 新模块：`src/daemon/requirement-scheduler.ts`
- req_dev workflow 加阶段：`await_review`、`fix_revision`
- requirement 状态机扩展：awaiting_review / fix_revision
- chat tool: `inject_feedback`
- Web UI: requirement 详情页加 PR 链接 + 注入反馈表单
- 替换 P2 临时降级，调度器接管 enqueue 后的执行

**验收**：
- 同 repo 入 3 个 → 第 1 个跑到 submit_pr 后第 2 个开始
- chat 注入反馈给第 1 个 → 第 2 个暂停 → 第 1 个修复 → push 同 PR → 第 2 个继续
- 完整跑完后第 3 个开始

### Phase 4：gh CLI 轮询监听器
**产出**：
- 新模块：`src/daemon/pr-poller.ts`，挂在现有 scheduler 周期跑
- 配置：`github.cli` / `github.poll_interval_seconds`
- requirements 表加 `last_reviewed_event_id` 字段（实际在 P2 schema 就建好，P4 才用）

**验收**：
- 在 GitHub 提交一个 Request changes review → ≤5 分钟内 autopilot 自动 inject_feedback

### Phase 5（可选）：体验打磨
- 健康检查 dashboard
- 队列重排 / 优先级
- 需求模板
- gh auth 状态在 UI 显示

## 13. 跨 phase 共性约束

- 每 phase 独立可发布、独立可回滚
- DB schema 一次到位（P2 就把 P3/P4 需要的字段建好），避免反复 migration
- 每 phase 至少 1 个 e2e 测试
- 每 phase 同步更新 `docs/`

## 14. 风险与缓解

| 风险 | 缓解 |
|------|------|
| chat agent 在多需求间混淆上下文 | 工具调用必须显式传 req_id；agent system prompt 强调维护 active req_id |
| 同 repo 队列长期被某个 fix_revision 卡住 | 30 次驳回上限触发 failed → 人工介入 |
| gh CLI 在 daemon 用户态下未登录 | 启动检查 `gh auth status`，未登录时 UI 顶部 banner 提示 |
| daemon 重启时 awaiting_review task 被误判 dangling | watcher 加白名单：`running_await_review` 排除在卡死检测外 |
| await_review 阶段函数永久 sleep 占用 task 槽 | sleep 是 await Bun.sleep（事件循环非阻塞）；daemon 重启时阶段函数从头跑（autopilot push 模型），无状态丢失 |
| 多个 daemon 进程重复 poll PR | daemon PID 锁 + supervisor 单实例，已有 |
| 需求 spec_md 过长导致 chat context 超限 | 入队时校验 spec_md ≤ 8KB（可配） |
| 外部命令注入 | 所有 git / gh 调用必须用 `Bun.spawn` argv 数组形式，禁止字符串拼接 |

## 15. 后续迭代（不在本次范围）

- 外部需求源接入器（GitHub Issues / 飞书 / Jira）—— `RequirementSource` 接口 + 多适配器
- 需求模板 / 类型（feat / fix / chore 等）
- 队列优先级 + 拖拽重排
- 多人协作（需求归属 / review 分配）
- PR webhook 支持（替代轮询）
- 跨需求依赖（"req-002 等 req-001 完成"）
