# 需求队列 P5.2 实施计划：req_dev workflow 阶段函数改造（跨父子）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 req_dev 5 个阶段函数（design / develop / code_review / submit_pr / fix_revision）跨父+子模块正确工作。完成后给 reverse-bot-gui 这种父+子结构提需求时，agent 能在父 repo 和子模块里都改代码 + commit + push + 各自创建 PR。

**Architecture:** `setup_req_dev_task` 从 P5.1 的 `listSubmodules` 拿子模块清单注入 task extra；阶段函数从 task extra 读 `submodules` 数组；新辅助函数 `runGitInSubmodule / submoduleHasChanges` 在子模块路径下跑 git；submit_pr 先依次 push 子模块 + 创建子 PR，再父 repo push + PR body 追加子 PR 清单 + 写 `requirement_sub_prs` 表。

**Tech Stack:** Bun + TypeScript，所有 git/gh 调用走 `Bun.spawn` argv 数组。

**Spec reference:** `docs/superpowers/specs/2026-05-07-submodule-support-design.md` §4.2 / §5（关键交互流程）/ §8 (Phase 5.2)

---

## File Structure

新建：

| 文件 | 职责 |
|------|------|
| `src/core/requirement-sub-prs.ts` | requirement_sub_prs 表 CRUD（appendSubPr / listSubPrs） |
| `tests/requirement-sub-prs.test.ts` | sub-prs CRUD 测试 |

修改：

| 文件 | 改动 |
|------|------|
| `examples/workflows/req_dev/workflow.ts` | setup 注入 submodules；5 阶段函数改造；2 辅助函数 |
| `tests/req_dev_setup.test.ts` | 追加 submodules 注入测试 |
| `tests/single-writer-invariant.test.ts` | 白名单加 `src/core/requirement-sub-prs.ts` |

---

## Tasks 一览

| # | Task | 关键产出 | 估时 |
|---|------|---------|------|
| 1 | `setup_req_dev_task` 注入 submodules 数组 | task extra 含 submodules 清单 | 20 min |
| 2 | requirement-sub-prs CRUD 模块 | append / list / 级联删 | 25 min |
| 3 | workflow.ts 加辅助函数 | runGitInSubmodule / submoduleHasChanges / SubmoduleInfo type | 15 min |
| 4 | run_design 起步加 submodule update + prompt | git submodule update --init --recursive；prompt 加清单 | 20 min |
| 5 | run_develop 改造跨父子 commit | 子模块切分支 → agent → 子模块 commit → 父 git add -A 一次 commit | 35 min |
| 6 | run_code_review 改造（父+子 diff 综合） | reviewer prompt 含全部 diff | 20 min |
| 7 | run_submit_pr 改造跨父子 PR | 先 push 子 + 创建子 PR；父 PR body 追加清单；写 sub_prs 表 | 40 min |
| 8 | run_fix_revision 改造（同 develop 模式） | 跨父子修复 + push 同分支 | 30 min |

**总估时**：约 3.5 小时（spec 估 3 hr）

---

## 共性约束

- TDD 优先；阶段函数本身实测困难（需真实 agent + git），单测覆盖辅助函数 + setup；端到端留 P5.4
- 每 task 一个 commit；message 中文
- 所有外部命令走 `Bun.spawn` argv 数组
- catch 用 `catch (e: unknown)`

---

## Task 1：setup_req_dev_task 注入 submodules

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`（setup 函数）
- Modify: `tests/req_dev_setup.test.ts`（追加测试）

### 改动

import 段加：

```ts
import { listSubmodules } from "@autopilot/core/submodules";
```

setup 返回值新增 `submodules` 字段：

```ts
export interface ReqDevSetupArgs {
  requirement_id?: string;
  repo_id: string;
  title: string;
  requirement: string;
}

export interface SubmoduleInfo {
  id: string;
  alias: string;
  path: string;                 // 绝对路径
  submodule_path: string;       // 父 repo 内相对路径
  default_branch: string;
  github_owner: string;
  github_repo: string;
}

export function setup_req_dev_task(args: ReqDevSetupArgs): Record<string, unknown> {
  const repo = getRepoById(args.repo_id);
  if (!repo) throw new Error(`repo not found: ${args.repo_id}`);

  // 拿子模块清单（P5.1 后 listSubmodules 总是返回数组，无 submodule 时为空）
  const submodules = listSubmodules(args.repo_id).map((sm): SubmoduleInfo => ({
    id: sm.id,
    alias: sm.alias,
    path: sm.path,
    submodule_path: sm.submodule_path ?? "",
    default_branch: sm.default_branch,
    github_owner: sm.github_owner ?? "",
    github_repo: sm.github_repo ?? "",
  }));

  // ... 现有逻辑（branch / repo_path 等）

  return {
    title: args.title,
    requirement: args.requirement,
    requirement_id: args.requirement_id,
    repo_id: repo.id,
    repo_path: repo.path,
    default_branch: repo.default_branch,
    branch,
    github_owner: repo.github_owner,
    github_repo: repo.github_repo,
    submodules,  // 新增
  };
}
```

### 测试追加

在 `tests/req_dev_setup.test.ts` 现有 describe 末尾：

```ts
import { listSubmodules } from "../src/core/submodules";

describe("setup_req_dev_task 注入 submodules", () => {
  // setup 的 testDb 复用现有（如果是 module-scoped）；否则 beforeAll 新建并 migrate

  it("无子模块时 submodules 为空数组", () => {
    // 创建一个 repo 不含子模块
    createRepo({ id: "repo-no-sub", alias: "no-sub", path: "/tmp/x" });
    const result = setup_req_dev_task({
      repo_id: "repo-no-sub",
      title: "x",
      requirement: "y",
    });
    expect(result.submodules).toEqual([]);
  });

  it("有子模块时注入数组", () => {
    createRepo({ id: "repo-with-sub", alias: "parent", path: "/tmp/parent" });
    createRepo({
      id: "repo-child",
      alias: "child",
      path: "/tmp/parent/child",
      default_branch: "master",
      github_owner: "foo",
      github_repo: "child",
      parent_repo_id: "repo-with-sub",
      submodule_path: "child",
    });
    const result = setup_req_dev_task({
      repo_id: "repo-with-sub",
      title: "feat",
      requirement: "x",
    });
    const submodules = result.submodules as Array<Record<string, unknown>>;
    expect(submodules.length).toBe(1);
    expect(submodules[0].alias).toBe("child");
    expect(submodules[0].submodule_path).toBe("child");
    expect(submodules[0].default_branch).toBe("master");
    expect(submodules[0].github_owner).toBe("foo");
  });
});
```

注意 setup 加 `migrate006(db)`（前面 fix 已加，但要确认这个文件正确）。

### 步骤

1. 改 setup_req_dev_task
2. 追加测试
3. typecheck + 跑测试
4. commit:
   ```
   git add examples/workflows/req_dev/workflow.ts tests/req_dev_setup.test.ts
   git commit -m "feat(workflow): setup_req_dev_task 注入 submodules 清单到 task extra"
   ```

---

## Task 2：requirement-sub-prs CRUD 模块

**Files:**
- Create: `src/core/requirement-sub-prs.ts`
- Create: `tests/requirement-sub-prs.test.ts`
- Modify: `tests/single-writer-invariant.test.ts`（白名单）

### 接口

```ts
import { getDb } from "./db";

export interface RequirementSubPr {
  id: number;
  requirement_id: string;
  child_repo_id: string;
  pr_url: string;
  pr_number: number;
  created_at: number;
}

export interface AppendSubPrOpts {
  requirement_id: string;
  child_repo_id: string;
  pr_url: string;
  pr_number: number;
}

/** 追加一条子模块 PR 记录；如已存在（UNIQUE 冲突）则更新 pr_url/pr_number */
export function appendSubPr(opts: AppendSubPrOpts): RequirementSubPr;

/** 列出某需求的所有子模块 PR（按 created_at 升序） */
export function listSubPrs(requirementId: string): RequirementSubPr[];
```

### 实现

```ts
export function appendSubPr(opts: AppendSubPrOpts): RequirementSubPr {
  const db = getDb();
  const ts = Date.now();
  // UPSERT 模式：UNIQUE(requirement_id, child_repo_id) 已建索引
  db.run(
    `INSERT INTO requirement_sub_prs (requirement_id, child_repo_id, pr_url, pr_number, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(requirement_id, child_repo_id) DO UPDATE SET
       pr_url = excluded.pr_url,
       pr_number = excluded.pr_number`,
    [opts.requirement_id, opts.child_repo_id, opts.pr_url, opts.pr_number, ts]
  );
  return db
    .query<RequirementSubPr, [string, string]>(
      "SELECT * FROM requirement_sub_prs WHERE requirement_id = ? AND child_repo_id = ?"
    )
    .get(opts.requirement_id, opts.child_repo_id) as RequirementSubPr;
}

export function listSubPrs(requirementId: string): RequirementSubPr[] {
  const db = getDb();
  return db
    .query<RequirementSubPr, [string]>(
      "SELECT * FROM requirement_sub_prs WHERE requirement_id = ? ORDER BY created_at ASC, id ASC"
    )
    .all(requirementId);
}
```

### 测试

```ts
describe("requirement-sub-prs", () => {
  // setup migrate004 + migrate005 + migrate006 + _setDbForTest
  // 创建 repo + requirement 满足 FK

  it("appendSubPr + listSubPrs", () => {
    appendSubPr({
      requirement_id: "req-001",
      child_repo_id: "repo-c",
      pr_url: "https://github.com/x/y/pull/1",
      pr_number: 1,
    });
    const list = listSubPrs("req-001");
    expect(list.length).toBe(1);
    expect(list[0].pr_url).toContain("/pull/1");
  });

  it("UPSERT 已存在时更新 pr_url/pr_number", () => {
    appendSubPr({
      requirement_id: "req-001",
      child_repo_id: "repo-c",
      pr_url: "https://github.com/x/y/pull/2",
      pr_number: 2,
    });
    const list = listSubPrs("req-001");
    expect(list.length).toBe(1);
    expect(list[0].pr_number).toBe(2);
  });

  it("不同需求隔离", () => {
    appendSubPr({
      requirement_id: "req-002",
      child_repo_id: "repo-c",
      pr_url: "https://github.com/x/y/pull/3",
      pr_number: 3,
    });
    expect(listSubPrs("req-001").length).toBe(1);
    expect(listSubPrs("req-002").length).toBe(1);
  });
});
```

### deleteRequirement 级联

读 `src/core/requirements.ts` 的 `deleteRequirement` 现有实现：

```ts
export function deleteRequirement(id: string): void {
  const db = getDb();
  db.run("DELETE FROM requirement_feedbacks WHERE requirement_id = ?", [id]);
  db.run("DELETE FROM requirements WHERE id = ?", [id]);
}
```

加一行：

```ts
db.run("DELETE FROM requirement_sub_prs WHERE requirement_id = ?", [id]);
```

放在删 feedbacks 之前或之后都行（FK 都被处理）。

### single-writer 白名单

加 `src/core/requirement-sub-prs.ts`。

### commit

```
git add src/core/requirement-sub-prs.ts src/core/requirements.ts tests/requirement-sub-prs.test.ts tests/single-writer-invariant.test.ts
git commit -m "feat(core): 加 requirement-sub-prs CRUD + deleteRequirement 级联"
```

---

## Task 3：workflow.ts 加辅助函数

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`

### 加 SubmoduleInfo 类型 + 辅助函数

```ts
// 已在 Task 1 加 SubmoduleInfo 接口

interface SubmoduleInfoFromTask {
  id: string;
  alias: string;
  path: string;
  submodule_path: string;
  default_branch: string;
  github_owner: string;
  github_repo: string;
}

/**
 * 在子模块路径下跑 git，参数风格跟 runGit 一致。
 */
function runGitInSubmodule(
  submodule: SubmoduleInfoFromTask,
  args: string[],
  check = true,
): { stdout: string; stderr: string; exitCode: number } {
  return runGit(args, submodule.path, check);
}

/**
 * 检测子模块是否有未提交改动（git status --porcelain 输出非空）。
 */
function submoduleHasChanges(submodule: SubmoduleInfoFromTask): boolean {
  const result = runGitInSubmodule(submodule, ["status", "--porcelain"], false);
  return result.exitCode === 0 && result.stdout.length > 0;
}

/**
 * 从 task extra 读 submodules 数组，类型守卫。
 */
function getTaskSubmodules(task: ReturnType<typeof getTask>): SubmoduleInfoFromTask[] {
  if (!task) return [];
  const raw = task["submodules"];
  if (!Array.isArray(raw)) return [];
  return raw as SubmoduleInfoFromTask[];
}
```

### commit

```
git add examples/workflows/req_dev/workflow.ts
git commit -m "feat(workflow): 加 submodule 辅助函数（runGitInSubmodule / submoduleHasChanges）"
```

---

## Task 4：run_design 起步加 submodule update + prompt

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`（run_design）

### 改动

在现有 `runGit(["pull", "--ff-only"], repoPath)` 之后追加：

```ts
// 拉子模块到引用 commit（initialize + update）
runGit(["submodule", "update", "--init", "--recursive"], repoPath, false);
```

`check = false` 因为没有 submodule 时此命令也安全（返回 0）。

### prompt 加子模块清单

在现有 design prompt 构造的位置追加：

```ts
const submodules = getTaskSubmodules(task);
let submodulesSection = "";
if (submodules.length > 0) {
  submodulesSection = `\n\n## 子模块\n\n本仓库含 ${submodules.length} 个子模块。在制订实现方案时，可以选择改父 repo、子模块、或两者：\n\n`;
  for (const sm of submodules) {
    submodulesSection += `- \`${sm.submodule_path}/\` — alias: ${sm.alias}, GitHub: ${sm.github_owner}/${sm.github_repo}, 默认分支: ${sm.default_branch}\n`;
  }
}

const prompt = `${baseDesignPrompt}${submodulesSection}`;
```

具体合并位置看现有 design prompt 拼接结构。

### 步骤

1. 读 workflow.ts run_design 函数
2. 加 submodule update 命令
3. prompt 加子模块清单段落
4. typecheck
5. commit:
   ```
   git add examples/workflows/req_dev/workflow.ts
   git commit -m "feat(workflow): run_design 加 submodule update + prompt 子模块清单"
   ```

---

## Task 5：run_develop 改造跨父子 commit

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`（run_develop）

### 改动

```ts
export async function run_develop(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";
  const submodules = getTaskSubmodules(task);

  // 1. 父 repo 切回主分支拉新（已有逻辑）
  runGit(["checkout", defaultBranch], repoPath);
  runGit(["pull", "--ff-only"], repoPath);

  // 2. 父 repo 切到 feat 分支
  const checkoutNew = runGit(["checkout", "-b", branch], repoPath, false);
  if (checkoutNew.exitCode !== 0) {
    runGit(["checkout", branch], repoPath);
  }

  // 3. 各子模块切到 feat 分支（先切到 default_branch 拉新，再切 feat）
  for (const sm of submodules) {
    runGitInSubmodule(sm, ["checkout", sm.default_branch]);
    runGitInSubmodule(sm, ["pull", "--ff-only", "origin", sm.default_branch], false);
    const smCheckoutNew = runGitInSubmodule(sm, ["checkout", "-b", branch], false);
    if (smCheckoutNew.exitCode !== 0) {
      runGitInSubmodule(sm, ["checkout", branch]);
    }
  }

  // 4. 调 agent（agent 可改父 + 子模块路径）
  const requirement = (task["requirement"] as string ?? "").trim();
  if (!requirement) throw new Error("任务 requirement 字段为空");

  const planContent = readPlanForDevelop(taskId, task.workflow);
  const reviewHistory = readReviewHistoryForDevelop(taskId, task.workflow);

  let submodulesSection = "";
  if (submodules.length > 0) {
    submodulesSection = `\n\n## 可改路径\n\n父仓库根：\`${repoPath}\`\n\n子模块（在子模块路径下改代码就行，不要切分支不要 commit）：\n`;
    for (const sm of submodules) {
      submodulesSection += `- \`${sm.submodule_path}/\` — ${sm.alias}\n`;
    }
  }

  const agent = getAgent("developer", task.workflow);
  const prompt =
    `按方案在仓库 ${repoPath} 实现代码：\n\n## 实现方案\n${planContent}\n${reviewHistory}${submodulesSection}\n\n` +
    `要求：\n` +
    `- 修改/新建必要的文件\n` +
    `- 不要切换分支（保持在当前分支）\n` +
    `- 不要 commit、不要 push（commit / push 由后续步骤处理）\n`;

  await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

  // 5. 各子模块：扫 git status，有改动则在子模块内 commit
  for (const sm of submodules) {
    if (submoduleHasChanges(sm)) {
      runGitInSubmodule(sm, ["add", "-A"]);
      runGitInSubmodule(sm, ["commit", "-m", `feat: ${task.title}`]);
    }
  }

  // 6. 父 repo: 一次 git add -A 包含「子模块 SHA bump」+「父自身改动」，再统一 commit
  runGit(["add", "-A"], repoPath);
  const cachedProc = Bun.spawnSync(
    ["git", "diff", "--cached", "--quiet"],
    { cwd: repoPath }
  );
  const hasParentStaged = cachedProc.exitCode !== 0;
  if (hasParentStaged) {
    runGit(["commit", "-m", `feat: ${task.title}`], repoPath);
  }

  // 7. 验证父 repo 至少有 1 个新 commit
  const logProc = Bun.spawnSync(
    ["git", "log", "--oneline", `${defaultBranch}..HEAD`],
    { cwd: repoPath, stderr: "pipe" }
  );
  const log = new TextDecoder().decode(logProc.stdout ?? new Uint8Array()).trim();
  if (!log) throw new Error("develop 阶段没有产生任何 commit");

  // 8. 状态机推进
  const transitions = getTransitions(task.workflow);
  await transition(taskId, "develop_complete", { transitions });
  runInBackground(taskId, "code_review");
}
```

⚠️ `readPlanForDevelop / readReviewHistoryForDevelop` 是占位 —— 用现有 workflow.ts 里 develop 函数的真实读 plan / review 反馈逻辑（应该是 `phaseDir` + `readFileSync`）。

### 步骤

1. 读 `examples/workflows/req_dev/workflow.ts` 现有 run_develop
2. 改造（保留现有 plan/review 读取逻辑，只在合适位置加子模块逻辑）
3. typecheck
4. commit:
   ```
   git add examples/workflows/req_dev/workflow.ts
   git commit -m "feat(workflow): run_develop 跨父子 commit（子模块改动 + 父 SHA bump 一次性 add）"
   ```

---

## Task 6：run_code_review 父+子 diff 综合

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`（run_code_review）

### 改动

```ts
// 现有：拿父 repo diff
const parentDiff = runGit([
  "diff", `${defaultBranch}...HEAD`, "--stat", "--patch"
], repoPath, false).stdout;

// 新增：各子模块 diff
let submodulesDiff = "";
for (const sm of submodules) {
  const smDiff = runGitInSubmodule(sm, [
    "diff", `${sm.default_branch}...HEAD`, "--stat", "--patch"
  ], false).stdout;
  if (smDiff && smDiff.trim()) {
    submodulesDiff += `\n\n## 子模块 ${sm.alias} (${sm.submodule_path}/)\n\n${smDiff.slice(0, 6000)}`;
  }
}

const fullDiff = parentDiff.slice(0, 8000) + submodulesDiff;
// reviewer prompt 用 fullDiff 而不是只有 parentDiff
```

### 步骤

1. 改 run_code_review 加 submodules diff 拼合
2. typecheck
3. commit:
   ```
   git add examples/workflows/req_dev/workflow.ts
   git commit -m "feat(workflow): run_code_review 综合父+子 diff 提交 reviewer"
   ```

---

## Task 7：run_submit_pr 跨父子 PR

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`（run_submit_pr）

### 改动

```ts
import { appendSubPr } from "@autopilot/core/requirement-sub-prs";

export async function run_submit_pr(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";
  const reqId = task["requirement_id"] as string | undefined;
  const submodules = getTaskSubmodules(task);

  // 1. 各子模块：检查是否有需要 push 的 commit
  type SubResult = { sm: SubmoduleInfoFromTask; pr_url: string; pr_number: number };
  const submoduleResults: SubResult[] = [];

  for (const sm of submodules) {
    const log = runGitInSubmodule(sm, [
      "log", "--oneline", `${sm.default_branch}..HEAD`
    ], false).stdout;
    if (!log.trim()) continue;  // 此子模块本次未改

    runGitInSubmodule(sm, ["push", "-u", "origin", branch]);

    // gh pr create / edit
    const ghCheck = Bun.spawnSync(
      ["gh", "pr", "view", "--json", "url,number"],
      { cwd: sm.path, stderr: "pipe" }
    );
    let smPrUrl: string;
    let smPrNumber: number;

    const smTitle = `${task.title}（子模块 ${sm.alias}）`;
    const smBody = `跟父仓库 PR 关联的子模块 PR：${sm.alias}\n\n本次 reverse-bot-rs 内的改动用于响应父需求。`;

    if (ghCheck.exitCode === 0 && ghCheck.stdout) {
      const parsed = JSON.parse(new TextDecoder().decode(ghCheck.stdout));
      smPrUrl = parsed.url ?? "";
      smPrNumber = parsed.number ?? 0;
      Bun.spawnSync(["gh", "pr", "edit", "--body", smBody], { cwd: sm.path });
    } else {
      const create = Bun.spawnSync(
        ["gh", "pr", "create", "--title", smTitle, "--body", smBody, "--base", sm.default_branch, "--head", branch],
        { cwd: sm.path, stdout: "pipe", stderr: "pipe" }
      );
      if (create.exitCode !== 0) {
        const err = new TextDecoder().decode(create.stderr ?? new Uint8Array());
        throw new Error(`子模块 ${sm.alias} gh pr create 失败：${err}`);
      }
      smPrUrl = new TextDecoder().decode(create.stdout).trim();
      const m = smPrUrl.match(/\/pull\/(\d+)$/);
      smPrNumber = m ? parseInt(m[1], 10) : 0;
    }

    submoduleResults.push({ sm, pr_url: smPrUrl, pr_number: smPrNumber });

    // 写 requirement_sub_prs（如果有 reqId）
    if (reqId) {
      appendSubPr({
        requirement_id: reqId,
        child_repo_id: sm.id,
        pr_url: smPrUrl,
        pr_number: smPrNumber,
      });
    }
  }

  // 2. 父 repo 现有逻辑（push + gh pr create / edit）
  runGit(["push", "-u", "origin", branch], repoPath);

  // 生成 PR body（已有 reviewer agent 调用），追加子 PR 清单
  let parentBody = await generatePrBodyViaReviewer(task, repoPath);
  if (submoduleResults.length > 0) {
    parentBody += "\n\n---\n\n## 关联子模块 PR\n\n";
    for (const r of submoduleResults) {
      parentBody += `- [${r.sm.alias}#${r.pr_number}](${r.pr_url})\n`;
    }
  }

  // 父 PR create / edit（同现有逻辑）
  const ghParentCheck = Bun.spawnSync(
    ["gh", "pr", "view", "--json", "url,number"],
    { cwd: repoPath, stderr: "pipe" }
  );
  let parentPrUrl: string;
  let parentPrNumber: number;
  if (ghParentCheck.exitCode === 0 && ghParentCheck.stdout) {
    const parsed = JSON.parse(new TextDecoder().decode(ghParentCheck.stdout));
    parentPrUrl = parsed.url ?? "";
    parentPrNumber = parsed.number ?? 0;
    Bun.spawnSync(["gh", "pr", "edit", "--body", parentBody], { cwd: repoPath });
  } else {
    const create = Bun.spawnSync(
      ["gh", "pr", "create", "--title", task.title, "--body", parentBody, "--base", defaultBranch, "--head", branch],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    if (create.exitCode !== 0) {
      throw new Error(`父 gh pr create 失败：${new TextDecoder().decode(create.stderr ?? new Uint8Array())}`);
    }
    parentPrUrl = new TextDecoder().decode(create.stdout).trim();
    const m = parentPrUrl.match(/\/pull\/(\d+)$/);
    parentPrNumber = m ? parseInt(m[1], 10) : 0;
  }

  // 3. 写 task extra（pr_url / pr_number 仍是父 PR）
  updateTask(taskId, { pr_url: parentPrUrl, pr_number: parentPrNumber });

  // 4. 状态机推进
  const transitions = getTransitions(task.workflow);
  await transition(taskId, "pr_submitted", { transitions });
  runInBackground(taskId, "await_review");
}
```

⚠️ `generatePrBodyViaReviewer` 是占位 —— 用现有 run_submit_pr 中调 reviewer agent 生成 PR body 的真实逻辑。

### 步骤

1. 读现有 run_submit_pr 完整代码
2. 改造（保留 reviewer agent 生成 body 逻辑，加子模块 push / PR / 写 sub_prs）
3. typecheck
4. commit:
   ```
   git add examples/workflows/req_dev/workflow.ts
   git commit -m "feat(workflow): run_submit_pr 跨父子 PR（子模块先 push + 创建 PR；父 body 追加链接）"
   ```

---

## Task 8：run_fix_revision 跨父子修复

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`（run_fix_revision）

### 改动

跟 run_develop 类似（切分支 → agent 写 → 各 repo commit → push）。差别：
- 切分支：父 + 子都 checkout 已有的 feat/<title>（不重建）
- agent prompt 含父 PR 反馈正文 + 当前父+子 PR 链接
- 各 repo 单独 push（不创建新 PR，是更新已有 PR）

```ts
export async function run_fix_revision(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;
  const reqId = task["requirement_id"] as string | undefined;
  const submodules = getTaskSubmodules(task);

  if (!reqId) throw new Error("fix_revision 需要 requirement_id");
  const latest = latestFeedback(reqId);
  if (!latest) throw new Error("没有 feedback 触发 fix_revision");

  // 1. 父 + 各子模块切到 feat 分支（已存在）
  runGit(["checkout", branch], repoPath);
  for (const sm of submodules) {
    runGitInSubmodule(sm, ["checkout", branch], false);  // 失败不阻塞（子模块可能没参与本次需求）
  }

  // 2. agent 写代码
  let submodulesSection = "";
  if (submodules.length > 0) {
    submodulesSection = `\n\n## 可改路径\n\n父仓库根：\`${repoPath}\`\n\n子模块：\n`;
    for (const sm of submodules) {
      submodulesSection += `- \`${sm.submodule_path}/\` — ${sm.alias}\n`;
    }
  }

  const agent = getAgent("developer", task.workflow);
  const prompt =
    `按 review 反馈修改代码：\n\n## review 反馈\n${latest.body}\n${submodulesSection}\n\n` +
    `要求：\n` +
    `- 改动需直接响应反馈\n` +
    `- 不要切换分支、不要 commit、不要 push\n`;

  await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

  // 3. 各子模块 commit + push（如有改动）
  for (const sm of submodules) {
    if (submoduleHasChanges(sm)) {
      runGitInSubmodule(sm, ["add", "-A"]);
      runGitInSubmodule(sm, ["commit", "-m", `fix: review 反馈修改`]);
      runGitInSubmodule(sm, ["push", "origin", branch]);
    }
  }

  // 4. 父 repo: add -A 一次性，commit + push
  runGit(["add", "-A"], repoPath);
  const cached = Bun.spawnSync(
    ["git", "diff", "--cached", "--quiet"],
    { cwd: repoPath }
  );
  if (cached.exitCode !== 0) {
    runGit(["commit", "-m", `fix: review 反馈修改`], repoPath);
  }
  runGit(["push", "origin", branch], repoPath);

  // 5. 状态机推进（fix_revision → await_review）
  const transitions = getTransitions(task.workflow);
  await transition(taskId, "fix_revision_complete", { transitions });
  runInBackground(taskId, "await_review");
}
```

### commit

```
git add examples/workflows/req_dev/workflow.ts
git commit -m "feat(workflow): run_fix_revision 跨父子修复 + push 同分支"
```

---

## Self-Review 检查表

### Spec 覆盖率

| Spec 章节 | 覆盖 task |
|-----------|-----------|
| §4.2 setup_req_dev_task 注入 submodules | T1 |
| §4.2 辅助函数 | T3 |
| §4.2 run_design 起步加 submodule update | T4 |
| §4.2 run_develop 跨父子 commit | T5 |
| §4.2 run_code_review 综合 diff | T6 |
| §4.2 run_submit_pr 跨父子 PR | T7 |
| §4.2 run_fix_revision 跨父子修复 | T8 |
| §3.2 requirement_sub_prs 表 CRUD（P5.1 schema 已建） | T2 |
| §4.6 删除级联（含 sub_prs） | T2（deleteRequirement 改造） |

不在 P5.2 范围（按 §8 留给 P5.3-5.4）：调度器组级 / Web UI 折叠展开 / chat tools 过滤 / 真实 e2e。

### Placeholder 扫描

✅ 无 TBD/TODO（spec 里 readPlanForDevelop / generatePrBodyViaReviewer 等占位是「按现有真实代码替换」的提示，不是 TBD）

### 类型一致性

- `SubmoduleInfo` 接口在 setup 和 workflow.ts 一致（同文件内）
- `RequirementSubPr` 接口在 core 与 workflow 一致

---

## 后续 Sub-phase

- **P5.3**：调度器组级锁 + Web UI 折叠展开 + chat tools 过滤子模块
- **P5.4**：测试 + 文档 + 用 reverse-bot-gui 真实跑闭环
