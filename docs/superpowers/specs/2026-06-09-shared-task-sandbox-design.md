# 设计：任务级共用沙盒（revert 即焚 + patch 模型）

- 日期：2026-06-09
- 状态：设计已确认，待写实现计划
- 关联：`docs/audits/2026-06-09-deep-audit.md`（即焚模型的 EPH-01~08 bug 集中地）

## 1. 背景与动机

2026-06 把任务沙盒从「任务级常驻 clone」重构为「agent 级即用即焚 + 全量 cumulative.patch」
（13 commit，commit `9489794..1a8edfa`）。本次深度审计暴露该模型是 bug 高发区：EPH-01（prompt
模式 cwd 丢改动）、EPH-02（diff_stat 算 0）、EPH-03/04（释放/decision.md 路径）、EPH-05（MCP
旁路）、EPH-06（零测试）、EPH-08/CONC-06（并行共享 patch 丢改动）——根因都在「即焚副本 + patch
往返」这套机制的复杂度。

用户决定退回更简单的模型，四个动机全选：**patch 模型太脆/bug 多、性能开销、阶段间想直接看到彼此
产物、心智模型简单**。

## 2. 目标 / 非目标

**目标**
- 一个任务一个共用沙盒：所有 phase 共用同一个工作目录，agent 直接在里面改文件。
- 去掉 `agent-sandbox.ts` 的即焚副本 + `cumulative.patch` 全量 patch 往返。
- 保留「源仓库零痕迹」红线（每任务独立 `clone --local`，不碰源仓库 .git）。
- 保留产物/artifacts 分离（每 phase 的文档/handoff 仍在 `artifacts/NN-phase/`）。

**非目标**
- 不支持并行块的多 read-write 子阶段（YAGNI，当前无 shipped 并行写工作流；留 TODO）。
- 不在本次引入 L2 环境沙箱（MicroVM）。

## 3. 模型设计

```
任务启动
  └─ git clone --local <源仓库> → runtime/tasks/<id>/workspace   ← 共用沙盒（独立 clone）
     └─ checkout base → 交付分支 feat/<...>
phase1（read-write）: agent cwd = workspace，直接改文件（未提交，留工作树）
phase2（read-only）: agent cwd = workspace，直接 git diff 看到 phase1 改动
...
submit_pr: 在 workspace 里 git add -A && commit && push → gh pr create
重跑: 删 workspace → 重新 clone（干净重来）
终态: 按 workspace_retention 策略清理 workspace（产物/日志保留）
```

- **代码累积方式**：工作树未提交累积，submit_pr 才 commit。各 phase 直接编辑工作树文件；
  code_review 跑 `git diff`（工作树）即看得到改动。这正是即焚之前的老模型。
- **源仓库零痕迹**：仍是独立 `clone --local`（硬链接 object），删除纯 rmSync，不碰源仓库。
- **产物分离不变**：`artifacts/NN-phase/`（文档/计划/handoff/agent-trace）与代码工作树正交，
  本次只换代码模型，产物模型不动。「沙盒」tab 仍展示 artifacts/（产物），代码工作树是 agent
  的执行目录、不需要在 tab 单独展示（可后续加）。

## 4. 改动面（拆 vs 接）

利好：旧的任务级 clone 机器即焚重构时**未删**（为 MCP start_task 保留），是「接回旧机器 +
拆即焚层」，非从零造。dev 工作流各 phase 用 `getCurrentSandboxDir() ?? task.repo_path` 取 cwd，
只要 `getCurrentSandboxDir()` 返回共用 clone，**dev workflow.ts 几乎零改动**。

| 拆掉（即焚层） | 接回 / 改 |
|---|---|
| `src/core/agent-sandbox.ts` 整文件：acquireAgentSandbox / captureAgentSandbox / releaseAgentSandbox / cumulativePatchPath / purgeAgentRuns | `task-factory.startTaskFromTemplate`：用 `ensureTaskSandbox`（真 clone，已存在）替 `prepareDeliverMeta`（只写 meta）；注入 `extra.repo_path = getTaskSandbox(taskId)` |
| `.agent-runs/` 目录 + `cumulative.patch` 概念 | `runner.executePhase` / `executeParallelGroup`：去掉 acquire/capture/release，改为注入 `sandboxDir = getTaskSandbox(taskId)`（共用 clone）到 task-context |
| `runner` 的 per-phase 副本生命周期包裹（acquire→run→capture→release） | `task-outcome.computeTaskOutcome`：diff_stat 改回对共用 clone 跑 `git diff origin/<base>`（clone 里现在真有改动/commit）；删 `computeDiffStatFromPatch` |
| `prompt-runner.resolveCodeRoot` 的即焚副本优先逻辑 | `resetTaskForRerun`：删 workspace → 重新 `ensureTaskSandbox`（替「清 patch + purgeAgentRuns」）；`deleteRemoteDeliverBranch` 幂等清旧分支不变 |
| `task-context.sandboxDir` 即焚语义 | dev `workflow.ts`：仅改 submit_pr/各 phase 的过期注释（「即焚副本已 apply patch」→「共用工作树已累积改动」），git 操作不变 |

被本次审计改过、需一并回退/调整的点：
- EPH-01 的 `resolveCodeRoot`（prompt-runner）：共用模型下 `getCurrentSandboxDir()` 恒返回共用
  clone，逻辑简化。
- EPH-02 的 `computeDiffStatFromPatch`：删，回退到 git diff（其单测随之改）。
- EPH-03 的 `deleteTaskSandbox`（释放）：共用模型下 workspace/ 就是代码 clone，删它 + artifacts/
  正确，基本不变。
- TC-01 的 `tests/agent-sandbox.test.ts`：删，换成共用沙盒链路测试。

## 5. 生命周期

- **创建**：task 启动时（task-factory）。`ensureTaskSandbox` 幂等（已存在非空则复用）。
- **重跑**：`resetTaskForRerun` 删 workspace → 重新 clone（用户已确认「重新 clone」而非 git reset）。
- **清理**：终态任务由现有 `workspace_retention`（config.yaml：days / max_total_mb）清 workspace；
  「释放」按钮（`deleteTaskSandbox`）手动清。产物/日志/记录保留。

## 6. 并行（不支持，YAGNI）

共用沙盒下并行块的多个 read-write 子阶段会同时改同一工作树 → 冲突。本次**不支持**：
- 共用沙盒服务串行工作流（当前 dev 串行）。
- `workflow.yaml` 若写并行块，子阶段共享工作树、改动可能互相覆盖——当前无 shipped 并行写
  工作流（parallel_build 示例连 phase 函数都没有），留 TODO。
- 可选轻量防御（实现计划再定）：runner 执行并行块时 log 一条「共用沙盒下并行写不隔离」警告。

## 7. 接受的取舍

- **失去 agent 级隔离**：即焚每次 fresh 副本是 memory `[[sandbox-runtime-isolation]]` 里 L2 环境
  沙箱（MicroVM）的前置（agent 即用即焚 ≈ MicroVM 模型）。共用沙盒后，未来上 L2 需重新设计这层。
  但用户动机 #3（阶段间直接看产物）正是要这个共享，故为**有意为之**——记一笔影响 L2 方向，非损失。
- **跨 phase 状态不隔离**：phase A 的副作用（装的依赖、改的非交付文件）会被 phase B 看到。串行
  工作流下这通常是想要的（增量推进）；但失去了「每 phase 干净起点」的保证。

## 8. 向后兼容 / 迁移

- **存量在飞任务**：切换时若有任务正处于即焚执行中（已有 cumulative.patch、无 workspace clone），
  会断裂。这是 dogfood 环境，可接受——切换前确认无在飞任务，或对在飞任务走重跑（重新 clone）。
- **`.worktree.json`**：即焚模型写 `mode:"clone"`；共用模型 `ensureTaskSandbox` 也写 clone 元数据，
  删除路径兼容。
- **MCP start_task**：本次审计（EPH-05）已让它复用 `startTaskFromTemplate`，自动跟随新模型。

## 9. 测试

- 新 `tests/task-sandbox-shared.test.ts`（替即焚链路测试）：真实临时 git 仓库 → 建共用 clone →
  phase1 改文件（不提交）→ phase2 在同一 clone 看到改动 → submit 模拟 commit → 断言；重跑断言
  workspace 被删 + 重新 clone 干净。
- `task-outcome` diff_stat 测试改回对真实 clone 跑 git diff。
- 全量 `bun test` + `bun run smoke-test` + `bun run build:web` 回归。
- 删 `tests/agent-sandbox.test.ts`（即焚链路）。

## 10. 风险

- **回退大重构**（reverses 13 commit），改动面跨 task-factory / runner / task-outcome / prompt-runner /
  sandbox / dev workflow + 测试。分阶段实施 + 每步全量绿。
- **diff_stat 回退到 git diff** 需确认共用 clone 在 submit_pr 后真有 commit/改动可算（dev submit_pr
  已 commit，OK；但 done 前的中间态 diff_stat 算的是工作树未提交改动，需用 `git diff`（不带 HEAD
  比较）或 `git add -A` 后 `git diff --cached base`）。
- **并行块**若用户后续真要用，需补隔离——本次明确不做，留 TODO + 警告。
