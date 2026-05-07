# 需求队列：git submodule 支持 设计文档

| | |
|---|---|
| 状态 | Draft |
| 日期 | 2026-05-07 |
| 作者 | larry |
| 上游依赖 | [需求队列工作模式](2026-05-06-requirement-queue-design.md) P1-P4 已落地 |

## 1. 背景与目标

### 1.1 现状

需求队列工作模式 P1-P4 已完整落地，但 req_dev workflow 把仓库当成单一 git 工作区处理，**完全没有 git submodule 概念**。所有阶段函数（design / develop / code_review / submit_pr / fix_revision）只对 `repo_path` 顶层执行 git 命令，不递归到子模块。

实际项目中 `reverse-bot-gui` 是典型例子：

```
reverse-bot-gui/                    ← 父 repo (前端 + Tauri)
├── .gitmodules
├── package.json
└── reverse-bot-rs/                 ← submodule (独立 GitHub repo)
    └── (Rust 后端代码)
```

跑 req_dev 时的失败模式：

| 场景 | 失败表现 |
|------|---------|
| 需求只改前端 | ✅ 正常 |
| 需求只改 Rust 后端 | ❌ submodule 内的改动 commit 落在子模块本地 HEAD，没 push；父 repo 看到 SHA bump 但子 PR 不存在；PR reviewer 无法拉取 |
| 跨前后端的需求 | ❌ 同上 + 还要求父子 PR 关联存在 |

### 1.2 目标

让 req_dev workflow 正确支持 git submodule 场景：

1. **自动发现子模块**：注册父 repo 时解析 `.gitmodules`，把每个子模块自动注册为关联 repo
2. **跨父子的 commit/push/PR**：阶段函数在子模块里也能 commit + push + 开 PR
3. **整体串行调度**：父 repo + 所有关联子模块视为一个组，组内最多 1 个 active task（spec §A1 严格串行的扩展）
4. **PR review 集中在父 PR**：约定所有 review 都写在父 PR 上；fix_revision 阶段 agent 自己路由到父或子
5. **数据完整性**：requirement 表关联父 PR；子 PR 信息存独立表

### 1.3 非目标

- ❌ git subtree / monorepo workspace（pnpm/yarn workspace 内的子包）—— 这些已经能 work，无需特殊处理
- ❌ 嵌套子模块（submodule 套 submodule）—— 一层就够；嵌套场景 P5+
- ❌ 子模块 URL 不是 GitHub —— P5 仅支持 github.com 子模块（其他 git 主机后续扩展）
- ❌ 子模块 PR 自动 merge 检测 —— 跟父 PR 解耦：父 PR merge 时 autopilot 标 done，子 PR 是否 merge 由用户在 GitHub 手动决定

## 2. 关键决策（已澄清）

| 维度 | 决策 | 原因 |
|------|------|------|
| 调度器锁粒度 | 父 + 所有子模块整体 1 把锁 | 避免跨父子 task 并发改子模块时 git 冲突；reverse-bot-gui 规模并发收益小，复杂度收益大 |
| PR review 监听 | 只盯父 PR | review 集中、pr-poller 简单；fix_revision 阶段 agent 自己路由 |
| 子模块发现 | 注册仓库时一次性解析 `.gitmodules` 自动注册 | 零运行时开销；UI 可视化关联；用户加/删子模块走「重新发现」按钮 |
| 子模块 DB 形式 | 自动注册成独立 `repos` 行 + `parent_repo_id` 标记 | 跟现有 repos schema 兼容；UI 一致；阶段函数能复用 getRepoById |
| 子模块分支命名 | 跟父 repo 同名（`feat/<title>`） | 简单一致；一个需求 = 一组同名分支跨父子 |
| 子模块 default_branch 来源 | `.gitmodules` 的 branch 字段 → `gh repo view --json defaultBranchRef` → 兜底 main | 兼容 reverse-bot-gui（reverse-bot-rs 是 master） |
| review 路由策略 | fix_revision 阶段 agent 拿父 PR 反馈，prompt 里告知所有可改路径 | agent 自己判断改父还是改子；保留灵活性 |
| 子 PR 失败处理 | 父 PR 提交失败时，已 push 的子 PR 留在 GitHub（人工处理） | 简化错误处理；rare case |

## 3. 数据模型

### 3.1 `repos` 表扩展（兼容现有数据）

```sql
ALTER TABLE repos ADD COLUMN parent_repo_id TEXT REFERENCES repos(id);
ALTER TABLE repos ADD COLUMN submodule_path TEXT;
-- parent_repo_id 非空 = 这是某个父 repo 的子模块
-- submodule_path = 父 repo 内的相对路径（如 'reverse-bot-rs'）
```

**约束（应用层校验）**：
- `parent_repo_id` 非空时 `submodule_path` 必须非空
- `parent_repo_id` 自身的 `parent_repo_id` 必须为空（不支持嵌套）
- 删除父 repo 时级联删子模块（`deleteRepo` 改造）

### 3.2 `requirement_sub_prs` 新表

```sql
CREATE TABLE requirement_sub_prs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  child_repo_id TEXT NOT NULL REFERENCES repos(id),
  pr_url TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(requirement_id, child_repo_id)
);
CREATE INDEX idx_sub_prs_req ON requirement_sub_prs(requirement_id);
```

记录一个需求关联的所有子模块 PR。`requirements.pr_url / pr_number` 仍存父 PR（不变）。

## 4. 架构改造

### 4.1 健康检查扩展

`POST /api/repos/:id/healthcheck` 在现有逻辑（path / git / origin / 自动回填 owner-repo）基础上：

1. 检测 `.gitmodules` 是否存在
2. 解析 `.gitmodules` 拿子模块清单（`git config -f .gitmodules --get-regexp 'submodule\..*\.path'` + `.url` + `.branch`）
3. 对每个子模块：
   - 检查 DB 是否已存在（`SELECT * FROM repos WHERE parent_repo_id = ? AND submodule_path = ?`）
   - 不存在 → `nextRepoId()` 创建新 repo 行
     - alias = 子模块 name（冲突时 `-2 / -3` 后缀）
     - path = 父 path + 子模块相对路径（绝对化）
     - default_branch = 解析顺序：`.gitmodules` 的 branch → `gh repo view <owner>/<repo> --json defaultBranchRef` → "main"
     - github_owner / github_repo = 从子模块 url 解析（用现有 `parseGithubFromRemote`）
     - parent_repo_id = 父 repo id
     - submodule_path = 子模块相对路径
   - 已存在 → 不动（用户可能调过 alias / default_branch）
4. 检测 DB 中**已注册但 `.gitmodules` 已删除**的子模块 → log warn，不自动删除（避免破坏关联 requirements）

新 API：`POST /api/repos/:id/rediscover-submodules` —— 显式触发同步（按钮在 UI 上）。

### 4.2 req_dev workflow 阶段函数改造

新增辅助函数：

```ts
// 列出父 repo 的所有 submodule 信息（从 DB 读，不解析 .gitmodules）
function getSubmodules(parentRepoId: string): Repo[];

// 在 submodule 路径下跑 git；返回跟 runGit 一样的结构
function runGitInSubmodule(submodule: Repo, args: string[]): { stdout, stderr, exitCode };

// 检测 submodule 是否有未提交改动（git status --porcelain）
function submoduleHasChanges(submodule: Repo): boolean;
```

每个阶段的具体改造：

#### `run_design` 起步

```ts
// 现有：
runGit(["checkout", defaultBranch], repoPath);
runGit(["pull", "--ff-only"], repoPath);

// 新增：
runGit(["submodule", "update", "--init", "--recursive"], repoPath);

// agent prompt 里加（如果有子模块）：
const submodules = getSubmodules(repo.id);
if (submodules.length > 0) {
  prompt += `\n\n## 子模块\n本仓库含 ${submodules.length} 个子模块，agent 可在以下路径改代码：\n`;
  for (const sm of submodules) {
    prompt += `- ${sm.submodule_path}/  (${sm.alias}, GitHub ${sm.github_owner}/${sm.github_repo})\n`;
  }
}
```

#### `run_develop`

```ts
// 1. 父 repo 切 feat/<title>（已有逻辑）
runGit(["checkout", defaultBranch], repoPath);
runGit(["pull", "--ff-only"], repoPath);
const branchExists = ...;
if (branchExists) runGit(["checkout", branch], repoPath);
else runGit(["checkout", "-b", branch], repoPath);

// 2. 子模块预切分支（agent 改之前先切到 feat/<title>，避免在 detached HEAD 上 commit）
const submodules = getSubmodules(repo.id);
for (const sm of submodules) {
  // 子模块当前可能在 detached HEAD（git submodule update 默认行为）
  // 切换到子模块的 default_branch 拉新 → 切到 feat/<title>
  runGitInSubmodule(sm, ["checkout", sm.default_branch]);
  runGitInSubmodule(sm, ["pull", "--ff-only", "origin", sm.default_branch], { check: false });
  const smBranchExists = runGitInSubmodule(sm, ["rev-parse", "--verify", branch]).exitCode === 0;
  if (smBranchExists) runGitInSubmodule(sm, ["checkout", branch]);
  else runGitInSubmodule(sm, ["checkout", "-b", branch]);
}

// 3. 调 agent 写代码（agent 可改父 + 任意子模块路径）
await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

// 4. 扫每个子模块：有改动 → 在子模块内 commit
const changedSubmodules: Repo[] = [];
for (const sm of submodules) {
  if (submoduleHasChanges(sm)) {
    runGitInSubmodule(sm, ["add", "-A"]);
    runGitInSubmodule(sm, ["commit", "-m", `feat: ${task.title}`]);
    changedSubmodules.push(sm);
  }
}

// 5. 父 repo: 一次 git add -A 包含「子模块 SHA bump」+「父自身改动」，再统一 commit
runGit(["add", "-A"], repoPath);
const cachedProc = Bun.spawnSync(
  ["git", "diff", "--cached", "--quiet"],
  { cwd: repoPath }
);
const hasParentStaged = cachedProc.exitCode !== 0;  // exitCode=1 表示有 staged 改动
if (hasParentStaged) {
  runGit(["commit", "-m", `feat: ${task.title}`], repoPath);
}

// 6. 验证：父 repo 至少有 1 个新 commit（含 SHA bump 也算）
const logProc = Bun.spawnSync(
  ["git", "log", "--oneline", `${defaultBranch}..HEAD`],
  { cwd: repoPath, stderr: "pipe" }
);
const log = new TextDecoder().decode(logProc.stdout ?? new Uint8Array()).trim();
if (!log) throw new Error("develop 阶段没有产生任何 commit");
```

#### `run_code_review`

agent 拿到的 diff 需要包含子模块的 diff（不只是父 repo 的 SHA bump）：

```ts
// 父 repo diff
const parentDiff = runGit(["diff", `${defaultBranch}...HEAD`, "--stat", "--patch"], repoPath).stdout;

// 各子模块 diff
let submodulesDiff = "";
for (const sm of submodules) {
  const smDiff = runGitInSubmodule(sm, ["diff", `${sm.default_branch}...HEAD`, "--stat", "--patch"]).stdout;
  if (smDiff) submodulesDiff += `\n\n## 子模块 ${sm.alias}\n${smDiff.slice(0, 6000)}`;
}

const fullDiff = parentDiff + submodulesDiff;
```

#### `run_submit_pr`

```ts
// 1. 各子模块（按 commit 时序）：push + 开 PR
const submoduleResults: { sm: Repo; pr_url: string; pr_number: number }[] = [];
for (const sm of submodules) {
  // 检查子模块是否有需要 push 的 commit（diff vs default_branch）
  const log = runGitInSubmodule(sm, ["log", "--oneline", `${sm.default_branch}..HEAD`]).stdout;
  if (!log) continue;  // 此子模块本次未改

  runGitInSubmodule(sm, ["push", "-u", "origin", branch]);

  // gh pr create / edit
  const existingProc = Bun.spawnSync(
    ["gh", "pr", "view", "--json", "url,number"],
    { cwd: sm.path, stderr: "pipe" }
  );
  let smPrUrl: string;
  let smPrNumber: number | null = null;
  if (existingProc.exitCode === 0 && existingProc.stdout) {
    const parsed = JSON.parse(...);
    smPrUrl = parsed.url;
    smPrNumber = parsed.number;
    Bun.spawnSync(["gh", "pr", "edit", "--body", smPrBody], { cwd: sm.path });
  } else {
    const createProc = Bun.spawnSync(
      ["gh", "pr", "create", "--title", task.title, "--body", smPrBody, "--base", sm.default_branch, "--head", branch],
      { cwd: sm.path, stderr: "pipe" }
    );
    smPrUrl = ...;
    smPrNumber = ...;
  }
  submoduleResults.push({ sm, pr_url: smPrUrl, pr_number: smPrNumber });
}

// 2. 父 repo：push + 开 PR；PR body 自动追加「关联子模块 PR」清单
runGit(["push", "-u", "origin", branch], repoPath);

let parentBody = generatedBody;  // agent 生成的 PR body
if (submoduleResults.length > 0) {
  parentBody += "\n\n---\n\n## 关联子模块 PR\n\n";
  for (const r of submoduleResults) {
    parentBody += `- [${r.sm.alias}#${r.pr_number}](${r.pr_url})\n`;
  }
}

// 父 PR create / edit（同现有逻辑）
const parentPrUrl = ...;
const parentPrNumber = ...;

// 3. 写 task extra（pr_url / pr_number 仍是父 PR）
updateTask(taskId, { pr_url: parentPrUrl, pr_number: parentPrNumber });

// 4. 写 requirement_sub_prs 表（新表）
const reqId = task["requirement_id"] as string;
for (const r of submoduleResults) {
  insertRequirementSubPr({
    requirement_id: reqId,
    child_repo_id: r.sm.id,
    pr_url: r.pr_url,
    pr_number: r.pr_number,
  });
}
```

#### `run_fix_revision`

跟 develop 类似（切分支 → agent 写 → 各 repo commit → 各 repo push）。差别：
- 切分支：父 + 子都 checkout 已有的 feat/<title>（不重建）
- agent prompt 里**加上父 PR 的 review 反馈正文**（取自 `latestFeedback(reqId)`）+ 当前父+子的所有 PR 链接，让 agent 知道要回应哪些反馈
- push：父子各自 push 到原分支（force 不要；让 GitHub 自然处理）

### 4.3 调度器扩展

`tickRepo(repoId)` 算法改造：

```ts
async function tickRepo(repoId: string): Promise<void> {
  // 找到组的"主仓库 id"：如果 repoId 是子模块，取它的 parent_repo_id
  const repo = getRepoById(repoId);
  if (!repo) return;
  const groupId = repo.parent_repo_id ?? repo.id;

  // 收集组内所有 repo（父 + 所有子模块）
  const groupRepoIds = [groupId, ...listSubmodules(groupId).map(sm => sm.id)];

  // 「占用槽位」= 组内任一 repo 的 requirement 处于 running 或 fix_revision
  const allRequirements = listRequirements({});  // 全部 requirement
  const active = allRequirements.filter(r =>
    groupRepoIds.includes(r.repo_id) &&
    (r.status === "running" || r.status === "fix_revision")
  );
  if (active.length > 0) return;

  // 拉最老 queued —— 仅从主仓库（用户在 chat 提需求时只会关联到父 repo）
  const queued = listRequirements({ repo_id: groupId, status: "queued" })
    .sort((a, b) => a.created_at - b.created_at);
  if (queued.length === 0) return;

  const candidate = queued[0];
  // ... 同现有逻辑
}
```

事件订阅：现有 `requirement:status-changed` 事件 → handler 调 `tickRepo(req.repo_id)`，因为 candidate.repo_id 总是父 repo（用户在 chat 创建需求时只会选父），所以这部分不变。

但 fix_revision / await_review 状态变化时，事件 payload 里的 `id` 是 requirement id，对应的 repo_id 是父 repo —— OK，符合预期。

### 4.4 chat tools / Web UI 改造

#### chat tools
- `list_repos`：只列父 repo（filter `parent_repo_id IS NULL`）—— 用户提需求时只能选父
- `create_requirement_draft`：repo_alias 解析 → 必须是父 repo（如果传入子模块 alias，报错提示用父 repo）

#### `/repos` UI
- 列表只显示父 repo
- 父 repo 行加展开按钮，点开显示关联子模块（path / GitHub / default_branch / 健康徽标）
- 父 repo 行加「重新发现子模块」按钮（调 `POST /api/repos/:id/rediscover-submodules`）

#### `/requirements/:id` UI
- 顶部 PR 链接区：现有「PR 链接」（父 PR）保留；新增「关联子模块 PR」列表（从 `requirement_sub_prs` 读，每条一个 GitHub 外链）

### 4.5 pr-poller 不变

只盯父 PR（spec §5.3）；CHANGES_REQUESTED 触发 fix_revision；merged 触发 done。子 PR 的 review/merge 不监听（设计决策）。

### 4.6 删除级联

- `deleteRepo(parent_id)`：先删所有 `parent_repo_id = parent_id` 的子模块行，再删父 repo
- `deleteRequirement(req_id)`：现有删 `requirement_feedbacks`，新增删 `requirement_sub_prs`

## 5. 关键交互流程示例

**场景**：用户给 reverse-bot-gui 提需求「在 Rust 后端加 hello 接口 + 前端调用」

```
[用户在 /chat] "我有个需求 — reverse-bot-gui 加 hello 接口"
  ↓
[chat agent] list_repos（只看到父 reverse-bot-gui）
  ↓ 询问、澄清
[chat agent] create_requirement_draft / update_spec / mark_ready / enqueue
  ↓ requirement.status = queued
[scheduler] tickRepo(reverse-bot-gui)
  ↓ 组内无 active task，拉走 candidate
[scheduler] startTaskFromTemplate(workflow=req_dev, repo_id=reverse-bot-gui, requirement_id=req-001)
  ↓ task 跑起来

[run_design]
  - git checkout main && git pull && git submodule update --init
  - agent 生成 plan（含「需要改 reverse-bot-rs 的 src/api.rs + reverse-bot-gui 的 src/api-client.ts」）

[run_review] PASS

[run_develop]
  - 父 repo: git checkout -b feat/hello
  - 子模块 reverse-bot-rs: git checkout master && pull && git checkout -b feat/hello
  - agent 在 reverse-bot-rs/src/api.rs 加 hello handler + reverse-bot-gui/src/api-client.ts 加调用
  - 子模块 commit: feat: 加 hello 接口
  - 父 repo: git add reverse-bot-rs && git add src && git commit: feat: 加 hello 接口

[run_code_review] 父 + 子 diff 一起审 → PASS

[run_submit_pr]
  - 子模块 reverse-bot-rs: git push -u origin feat/hello + gh pr create → PR ReverseGame/reverse-bot-rs#123
  - 父 repo: git push + gh pr create → PR ReverseGame/reverse-bot-gui#456
  - 父 PR body 自动加「关联子模块 PR: [reverse-bot-rs#123](...)」
  - requirement.pr_url/pr_number = 父 PR
  - requirement_sub_prs: (req-001, reverse-bot-rs, .../pull/123, 123)

[run_await_review] requirement.status = awaiting_review → 调度器释放槽位

（用户在父 PR #456 上 GitHub Request changes：「hello 接口要加 timeout 参数」）

[pr-poller] 5min 后扫到父 PR 有 CHANGES_REQUESTED
  → inject_feedback(req-001, source=github_review, body="hello 接口要加 timeout 参数")
  → setRequirementStatus(req-001, fix_revision)
  → run_await_review 检测到状态变化 → emit revision_request → 跳到 fix_revision 阶段

[run_fix_revision]
  - 切到原 feat/hello 分支（父 + 子）
  - agent prompt 含 父 PR 反馈 + 父 PR + 子 PR 链接
  - agent 在 reverse-bot-rs/src/api.rs 加 timeout 参数
  - 子模块 commit: 按 review 反馈修改 + push origin feat/hello
  - 父 repo: git add reverse-bot-rs + commit: bump reverse-bot-rs + push origin feat/hello
  → 父 PR 和子 PR 都有新 commit
[run_await_review] 回到等待

（用户审完 + merge 父 PR；子模块 PR 用户单独 merge 或保持 open，autopilot 不管）

[pr-poller] 父 PR merged → setRequirementStatus(req-001, done)
[run_await_review] forceTransition(task, done)
```

## 6. 错误处理

| 场景 | 处理 |
|------|------|
| `.gitmodules` 解析失败（语法错） | 健康检查 issues 加一条；继续注册父 repo 但不发现子模块 |
| 子模块 url 不是 github.com | 跳过该子模块（不注册），log warn；P5 仅支持 GitHub |
| 子模块 path 实际不存在（仅 .gitmodules 有） | 健康检查标 warning；不注册；用户需手动 `git submodule update --init` |
| develop 阶段 agent 改了子模块但子模块 default_branch 拉不下来 | 抛错回 review 阶段（drive workflow 状态机驳回） |
| submit_pr 子模块 push 失败（网络 / 权限） | 抛错；父 PR 不创建；子 PR 也不存在 → 干净状态 |
| submit_pr 子 PR 创建成功但父 PR 失败 | 父 PR 创建错误抛出；已 push 的子模块 + 已创建的子 PR 留在 GitHub（rare case，人工处理） |
| fix_revision 阶段子模块出现合并冲突 | 抛错回 develop；agent 重试时会 pull 最新解冲突 |
| 用户手动删了 `.gitmodules` 里某子模块条目 | 健康检查发现 DB 有但 `.gitmodules` 没 → log warn，不自动删 DB（避免破坏关联 requirements） |

## 7. 测试策略

### 7.1 单元测试
- 子模块解析：`.gitmodules` → 子模块 list（多种格式：单/多模块、含 branch / 不含 branch）
- 健康检查扩展：mock fs 和 git，验证子模块自动注册逻辑
- `tickRepo` 组级算法：父+子组内 active 检测
- `requirement_sub_prs` CRUD

### 7.2 e2e 测试
- 注册带子模块的 repo + 健康检查 → DB 中父+子都存在
- `tickRepo` 在不同组成员状态下的拉新行为
- `req_dev` 阶段函数 mock：跳过真实 agent / git，验证 workflow 路径

### 7.3 手工 e2e
- 用 reverse-bot-gui 跑一个跨父子的真实需求

## 8. 分阶段交付

P5 太大，进一步拆 sub-phase：

### Phase 5.1：DB schema + 健康检查扩展（基础）
- migration 006：repos 表加 parent_repo_id / submodule_path；新增 requirement_sub_prs 表
- 健康检查扩展：解析 `.gitmodules` + 自动注册子模块
- `POST /api/repos/:id/rediscover-submodules` 端点
- core 层：`getSubmodules / parseGitmodules` 等辅助

### Phase 5.2：req_dev workflow 阶段函数改造
- 辅助函数：`runGitInSubmodule / submoduleHasChanges`
- 改造 5 个阶段函数（design / develop / code_review / submit_pr / fix_revision）
- agent prompt 模板更新

### Phase 5.3：调度器组级锁 + Web UI
- `tickRepo` 改造：组级 active 检测
- Web UI `/repos` 父 repo 折叠展开子模块；`/requirements/:id` 子模块 PR 列表
- chat tools `list_repos` 过滤掉子模块（仅列父）

### Phase 5.4：测试 + 文档
- 单测 + e2e
- 用户指南更新（docs/requirement-queue.md 加 submodule 章节）
- 手工跑 reverse-bot-gui 的需求

各 sub-phase 独立可发布。

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| reverse-bot-rs 在 `.gitmodules` 里的 url 是 https，CI 上拉子模块失败 | 不强制 CI；用户自己用 `git submodule update --init` 拉 |
| 子模块 default_branch 跟父 repo 不一致（reverse-bot-rs=master，主仓 main） | 设计已涵盖：每个 repo 独立 default_branch 字段 |
| 多个子模块时 PR body 列表长 | 截断显示前 10 个；剩余「... and N more」 |
| 子模块 PR 跟父 PR 状态不同步（子 PR merged 父 PR 没 merge） | 不监控；user 手动处理；spec §1.3 已声明非目标 |
| 嵌套子模块 | 显式不支持，健康检查时 log warn |
| 子模块跟用户已注册的另一个 repo 冲突 | alias 自动加后缀（reverse-bot-rs vs reverse-bot-rs-2） |
| `.gitmodules` 里 path 含 `..` 路径穿越 | 解析时拒绝并 log warn |

## 10. 后续扩展（非本次范围）

- 子模块 PR review 自动监听（需扩展 pr-poller）
- 嵌套子模块（递归）
- 非 GitHub 子模块（GitLab / Bitbucket）
- 子模块改动跟父 repo SHA bump 强一致性（防漏 add）
- pnpm/yarn workspace 子包关联（同 repo 内多 package 但不是 submodule）

---

## 附录：实现复杂度估计

| Sub-phase | 估时 | 风险 |
|-----------|------|------|
| 5.1 DB + 健康检查 | 2 hr | 低 |
| 5.2 workflow 阶段函数 | 3 hr | 中（agent prompt 调试） |
| 5.3 调度器 + UI | 2 hr | 低 |
| 5.4 测试 + 文档 | 1.5 hr | 低 |
| **总计** | **~8.5 hr** | |
