# A1 阶段 2：级联取消单一实现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把散在 4 处的级联取消重复代码（`for(listRootTasksByRequirementIds){try cancelTaskAction}catch{}`）收编进单一 `cancelTasksForRequirements` 函数，让 SC-1 级联只有一份实现、不会各处漂移。

**Architecture:** 新增 `cancelTasksForRequirements(reqIds)` 于 `src/daemon/task-actions.ts`（best-effort 级联取消给定需求名下的根任务）。4 个调用点（`cancelRequirementWithTasks` 自身、`requirements.delete` RPC、`projects.delete` RPC、REST 删需求）全部改调它。纯行为保持重构——不改任何取消语义，只消除重复。

**Tech Stack:** Bun + TypeScript strict；测试 `bun:test`（扩展现有 `tests/task-actions.test.ts`）。

## 偏离设计稿说明（重要）
设计稿 `2026-06-09-task-lifecycle-coordinator-design.md` §1.1/§4 阶段 2 原写「`cancelTasksForRequirements` 放 `src/core/task-lifecycle.ts`」+「`cancelTaskAction` 变薄 wrapper over core `cancelTask`」。实施时据真实代码调整：

1. **`cancelTasksForRequirements` 放 `daemon/task-actions.ts` 而非 core**：若放 core/task-lifecycle，它需调 `forgetTaskRecoveryState`（core/watcher）→ 形成 `task-lifecycle → watcher → runner → task-lifecycle` 循环依赖。且 `task-actions.ts` 文件头自述职责即「抽自 routes.ts 让 HTTP routes 和 WS RPC 共用同一份业务逻辑」——级联 helper 的正确归属正是这里。
2. **不做「`cancelTaskAction` 变薄 wrapper 进 core」**（YAGNI）：`cancelTaskAction` 已是干净的单任务取消入口，拆进 core 只增加间接层 + 触发上述循环依赖，零行为收益。本阶段只做高价值、低风险的级联收口。

设计稿的核心目标（SC-1 级联只有一份实现、cancelTaskAction 是单任务唯一入口、零行为改动）均达成。

---

## 文件结构
- **改** `src/daemon/task-actions.ts` — 新增 `cancelTasksForRequirements`；`cancelRequirementWithTasks` 改调它。
- **改** `src/daemon/rpc-methods.ts` — `requirements.delete` / `projects.delete` 两处级联循环改调 `cancelTasksForRequirements`；修过期注释；删不再用的 `listRootTasksByRequirementIds` import。
- **改** `src/daemon/routes.ts` — REST 删需求级联循环改调；删不再用的 import。
- **改** `tests/task-actions.test.ts` — 加 `cancelTasksForRequirements` 测试。

---

## Task 1：cancelTasksForRequirements 单一实现 + cancelRequirementWithTasks 改调

**Files:**
- Modify: `src/daemon/task-actions.ts`
- Test: `tests/task-actions.test.ts`

- [ ] **Step 1: 写失败测试**

打开 `tests/task-actions.test.ts`，把第 27 行的 import 改为加上 `cancelTasksForRequirements`：

```ts
import { cancelRequirementWithTasks, cancelTasksForRequirements, restartTaskAction, TaskActionError } from "../src/daemon/task-actions";
```

在 `cancelRequirementWithTasks` 的 describe 之后（restartTaskAction describe 之前或文件末尾）追加：

```ts
describe("cancelTasksForRequirements（级联取消单一实现）", () => {
  it("级联取消多个需求名下的所有 root 任务，返回取消数", () => {
    createProject({ id: "proj-c1", name: "p" });
    const reqA = nextRequirementId();
    createRequirement({ id: reqA, project_id: "proj-c1", title: "A" });
    const reqB = nextRequirementId();
    createRequirement({ id: reqB, project_id: "proj-c1", title: "B" });
    createTask({ id: "tk-a1", title: "A1", workflow: "dev", initialStatus: "running_design", requirementId: reqA });
    createTask({ id: "tk-b1", title: "B1", workflow: "dev", initialStatus: "running_design", requirementId: reqB });

    const { cancelled } = cancelTasksForRequirements([reqA, reqB]);

    expect(cancelled).toBe(2);
    expect(getTask("tk-a1")?.status).toBe("cancelled");
    expect(getTask("tk-b1")?.status).toBe("cancelled");
  });

  it("best-effort：已终态任务被跳过、不抛错、不计入取消数", () => {
    createProject({ id: "proj-c2", name: "p2" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-c2", title: "T" });
    createTask({ id: "tk-live", title: "live", workflow: "dev", initialStatus: "running_design", requirementId: reqId });
    createTask({ id: "tk-dead", title: "dead", workflow: "dev", initialStatus: "done", requirementId: reqId });

    const { cancelled } = cancelTasksForRequirements([reqId]);

    expect(cancelled).toBe(1); // 只取消了存活的那个
    expect(getTask("tk-live")?.status).toBe("cancelled");
    expect(getTask("tk-dead")?.status).toBe("done"); // 终态不动
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-actions.test.ts`
Expected: FAIL —— `cancelTasksForRequirements` 不是导出函数（import 解析失败 / 类型报错）。

- [ ] **Step 3: 写实现**

打开 `src/daemon/task-actions.ts`。在 `cancelRequirementWithTasks` 的注释块（约 102-110 行 `// cancelRequirementWithTasks — 取消需求并级联停名下任务`）之前，插入新函数：

```ts
// ──────────────────────────────────────────────
// cancelTasksForRequirements — 级联取消多个需求名下的根任务（单一实现）
// ──────────────────────────────────────────────

/**
 * 级联取消给定需求名下的全部 root 任务（best-effort：已终态 / 不存在的跳过不抛）。
 * 收编原先散在 4 处（cancelRequirementWithTasks / requirements.delete / projects.delete /
 * REST 删需求）的重复 `for(roots){try cancelTaskAction}catch{}`，让 SC-1 级联只有一份实现、
 * 不会各处漂移。返回实际取消的任务数。
 */
export function cancelTasksForRequirements(reqIds: string[]): { cancelled: number } {
  let cancelled = 0;
  for (const t of listRootTasksByRequirementIds(reqIds)) {
    try {
      cancelTaskAction(t.id);
      cancelled++;
    } catch {
      /* 已终态 / 不存在：忽略，调用方（删记录 / 置需求 cancelled）兜底 */
    }
  }
  return { cancelled };
}
```

然后把 `cancelRequirementWithTasks` 的函数体（约 111-120 行）从：

```ts
export function cancelRequirementWithTasks(reqId: string): { requirement: Requirement } {
  for (const t of listRootTasksByRequirementIds([reqId])) {
    try {
      cancelTaskAction(t.id);
    } catch {
      /* 已终态 / 不存在：忽略，下面置需求 cancelled 兜底 */
    }
  }
  return { requirement: setRequirementStatus(reqId, "cancelled") };
}
```

改为：

```ts
export function cancelRequirementWithTasks(reqId: string): { requirement: Requirement } {
  cancelTasksForRequirements([reqId]);
  return { requirement: setRequirementStatus(reqId, "cancelled") };
}
```

（`listRootTasksByRequirementIds` 已在该文件第 15 行 import，新函数复用，无需改 import。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/task-actions.test.ts`
Expected: PASS（新增 2 用例 + 原有 SC-1/SC-2 用例全过——cancelRequirementWithTasks 现在内部走 helper，原 SC-1 测试验证级联未漂移）。

- [ ] **Step 5: typecheck + 提交**

```bash
bun run typecheck
git add src/daemon/task-actions.ts tests/task-actions.test.ts
git commit -m "feat(daemon): A1-P2 cancelTasksForRequirements 级联取消单一实现"
```
typecheck 必须无报错。

---

## Task 2：3 处级联调用点改调单一实现 + 修过期注释 + 清死 import

**Files:**
- Modify: `src/daemon/rpc-methods.ts`（requirements.delete + projects.delete 两处 + import）
- Modify: `src/daemon/routes.ts`（REST 删需求一处 + import）

> 纯行为保持的接线：3 处的 `for(roots){try cancelTaskAction}catch{}` 换成 `cancelTasksForRequirements(...)`（Task 1 已测）。无新测试，靠全量 `bun test`（含 `project-cascade-delete` / `requirement-delete-cascade` / `task-actions` 测试）保证行为不变。

- [ ] **Step 1: 改 rpc-methods.ts 的 import**

打开 `src/daemon/rpc-methods.ts`。找到从 `./task-actions` 的 import（约 122-128 行，含 `cancelTaskAction,` 和 `cancelRequirementWithTasks,`），加上 `cancelTasksForRequirements`，例如把 `cancelTaskAction,` 那行后补一行：

```ts
  cancelTasksForRequirements,
```

找到从 `../core/db` 的 import（第 53 行）：

```ts
import { setKv, listRootTasksByRequirementIds, getDb } from "../core/db";
```

改为（删 `listRootTasksByRequirementIds`，本文件改完后不再用）：

```ts
import { setKv, getDb } from "../core/db";
```

- [ ] **Step 2: 改 requirements.delete handler（rpc-methods.ts 约 945-953）**

把：

```ts
      // 删前先停运行中任务的 agent 进程（best-effort）：让 runner 收敛、释放 worktree 占用，
      // 再由 deleteRequirementWithTasks 强删记录。cancel 是异步的，这里不 sleep 等它生效。
      for (const t of listRootTasksByRequirementIds([p.id])) {
        try {
          cancelTaskAction(t.id);
        } catch {
          /* 已终态 / 不存在：忽略，强删兜底 */
        }
      }
      const { deletedTasks } = deleteRequirementWithTasks(p.id);
```

改为：

```ts
      // 删前先停运行中任务的 agent 进程（best-effort）：让 runner 收敛、释放 sandbox 占用，
      // 再由 deleteRequirementWithTasks 强删记录。cancel 同步触发 abort（向子进程发 SIGTERM），
      // 但不阻塞等子进程实际退出 / phase 收敛，故不 sleep。
      cancelTasksForRequirements([p.id]);
      const { deletedTasks } = deleteRequirementWithTasks(p.id);
```

- [ ] **Step 3: 改 projects.delete handler（rpc-methods.ts 约 1706-1716）**

把：

```ts
        // 删前先停运行中任务的 agent 进程（best-effort）：让 runner 收敛、释放 worktree 占用，
        // 再由 coreDeleteProject 强删记录。cancel 是异步的，这里不 sleep 等它生效。
        const reqs = listRequirementsByProject(p.id);
        for (const t of listRootTasksByRequirementIds(reqs.map((r) => r.id))) {
          try {
            cancelTaskAction(t.id);
          } catch {
            /* 已终态 / 不存在：忽略，强删兜底 */
          }
        }
        coreDeleteProject(p.id);
```

改为：

```ts
        // 删前先停运行中任务的 agent 进程（best-effort）：让 runner 收敛、释放 sandbox 占用，
        // 再由 coreDeleteProject 强删记录。cancel 同步触发 abort（向子进程发 SIGTERM），但不阻塞
        // 等子进程实际退出 / phase 收敛，故不 sleep。
        const reqs = listRequirementsByProject(p.id);
        cancelTasksForRequirements(reqs.map((r) => r.id));
        coreDeleteProject(p.id);
```

> 注意：`cancelTaskAction` 在 rpc-methods.ts 仍被 `tasks.cancel`（约 564 行 `return cancelTaskAction(p.id);`）使用，**不要删它的 import**。`listRequirementsByProject` 保留。

- [ ] **Step 4: 改 routes.ts 的 import + REST 删需求 handler**

打开 `src/daemon/routes.ts`。找到第 19 行从 `../core/db` 的 import，删掉其中的 `listRootTasksByRequirementIds`（routes.ts 改完后仅 928 处用过它）。原行：

```ts
import { initDb, getDb, getTask, createTask, listTasks, getTaskLogs, getSubTasks, updateTask, listRootTasksByRequirementIds } from "../core/db";
```

改为：

```ts
import { initDb, getDb, getTask, createTask, listTasks, getTaskLogs, getSubTasks, updateTask } from "../core/db";
```

找到第 37 行从 `./task-actions` 的 import，加上 `cancelTasksForRequirements`：

```ts
import { cancelTaskAction, restartTaskAction, answerTaskAction, decideTaskAction, releaseTaskSandboxAction, cancelRequirementWithTasks, cancelTasksForRequirements, TaskActionError } from "./task-actions";
```

找到 REST 删需求 handler（约 925-935 行）：

```ts
        // 删一件工作 = 需求 + 其名下全部任务（含运行中）。先 best-effort 停 agent 再强删，
        // 与 WS RPC requirements.delete / 项目级联删除同一语义，不留孤儿任务。
        for (const t of listRootTasksByRequirementIds([reqDetailMatch])) {
          try {
            cancelTaskAction(t.id);
          } catch {
            /* 已终态 / 不存在：忽略，强删兜底 */
          }
        }
        const { deletedTasks } = deleteRequirementWithTasks(reqDetailMatch);
```

改为：

```ts
        // 删一件工作 = 需求 + 其名下全部任务（含运行中）。先 best-effort 停 agent 再强删，
        // 与 WS RPC requirements.delete / 项目级联删除同一语义，不留孤儿任务。
        cancelTasksForRequirements([reqDetailMatch]);
        const { deletedTasks } = deleteRequirementWithTasks(reqDetailMatch);
```

> 注意：`cancelTaskAction` 在 routes.ts 仍被 POST /api/tasks/:id/cancel（约 952 行 `return json(cancelTaskAction(cancelMatch));`）使用，**不要删它的 import**。

- [ ] **Step 5: typecheck + 全量测试 + 提交**

```bash
bun run typecheck
bun test
git add src/daemon/rpc-methods.ts src/daemon/routes.ts
git commit -m "refactor(daemon): A1-P2 级联取消调用点统一走 cancelTasksForRequirements"
```
Expected: `bun run typecheck` 无报错；`bun test` 全绿（≥1014 pass，含 Task 1 新增 2 用例；project-cascade-delete / requirement-delete-cascade / task-actions 全过证明行为未变）。

---

## 收尾
两 task 完成后用 superpowers:finishing-a-development-branch 收口。

**遗留（不在本阶段）：** 设计稿阶段 3（submit_pr push 前协作检查点 + 半态重跑覆盖）、阶段 4（watcher 放弃任务 abort）、并行块 executeParallelGroup 接 controller。

## Self-Review

**1. Spec coverage（对照设计稿 §4 阶段 2 + §1.1）：**
- 「级联取消单一实现 cancelTasksForRequirements」→ Task 1 ✅（放 daemon/task-actions，偏离已说明）
- 「4 处 for(){try cancel}catch{} 统一」→ cancelRequirementWithTasks（Task 1）+ requirements.delete/projects.delete（Task 2）+ REST 删需求（Task 2）= 4 处全收 ✅
- 「修 3 处『cancel 是异步的』过期注释」→ Task 2 改了 rpc 的 2 处（requirements.delete / projects.delete）；REST 删需求处原注释无「异步」措辞、本就准确，不需改。设计稿说的「3 处」实际仓里只有 2 处含该措辞（已核实 grep）。
- 「cancelTaskAction 变薄 wrapper 进 core」→ **刻意不做**（YAGNI + 避循环依赖，已在偏离说明）。
- SC-1 不复活 → Task 1 保留原有 SC-1 测试（cancelRequirementWithTasks 内部走 helper，测试验证级联未漂移）。✅

**2. Placeholder scan：** 无 TBD/TODO；每步给完整真实代码（基于实际读取的 task-actions.ts:46-120 / rpc-methods.ts:938-958,1698-1722 / routes.ts:918-957 现状）。

**3. Type consistency：** `cancelTasksForRequirements(reqIds: string[]): { cancelled: number }` 在 Task 1 定义，Task 2 三处调用签名一致（传 `string[]`，返回值不消费）。`listRootTasksByRequirementIds` 删除范围已逐文件核（rpc-methods 仅 947/1709 用、routes 仅 928 用，删后无残留引用；task-actions.ts 仍用故不删那处 import）。
