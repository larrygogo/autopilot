# 需求是任务的前置条件 — 实现计划（Phase 1）

> 日期：2026-06-04
> 范围：core / daemon / cli + 一条迁移；不动 web 渲染（流水线已就绪）
> 状态：设计已定，待用户确认后实施

## 决策（用户已拍板）

1. 每个任务必有需求，不存在游离任务（requirement_id 为空的 task）。
2. 快捷路径硬要求先有需求，但保住一行起活的手感：
   - `task start "<描述>"`（无 -r）：agent 把描述总结成需求标题 → 建一条真需求（进需求池、可调查/复盘）→ 任务挂其下。
   - `startAdHoc`（一句话发包）：内部先建需求再跑，体验不变。
   - 复用已有 `extractRequirement`（agent 抽取）。
3. 分阶段：Phase 1 只做应用层强制 + 可回退回填迁移；DB 层 NOT NULL + FK 留到 Phase 2（dogfood 确认无新游离任务再上，不可回退那一刀单独做）。

## 架构定位（来自 architect 评估）

- 采用方案 A：概念统一、物理仍两表，task 永远背靠一条 requirement。
- 唯一任务创建收口点：`src/core/task-factory.ts` 的 `startTaskFromTemplate`（`opts.reqId ?? null` 是游离根源）。
- 回归雷：
  1. `createSubTask`（并行子任务）当前完全不写 requirement_id → 加强制前必崩，必须先让它继承父 task 的 requirement_id。
  2. 历史游离 task（requirement_id 为空）→ 迁移回填，否则 Phase 2 加约束时炸。
  3. 大量测试直接 createTask 不带需求 → 要改测试辅助。
- requirement 需要 project_id（NOT NULL），游离 task 无 project 维度 → 迁移建兜底项目挂回填需求（或从 task 关联 codebase 反查 project）。

---

## Task 1: createSubTask 继承父 requirement_id（拆雷，先做）

Files: `src/core/db.ts`（createSubTask）

- 在子任务 INSERT 时把 requirement_id 设为父 task 的 requirement_id。
- typecheck 通过；并行工作流相关测试跑一遍。
- Commit：fix(core): 并行子任务继承父任务 requirement_id

## Task 2: 快捷路径"先建需求再跑"的共享 helper

Files: 新增 `src/core/start-from-prompt.ts`（或并入 requirements.ts）

- `startTaskFromPrompt({ prompt, workflow?, codebase_id? })`：
  1. extractRequirement(prompt)（agent 总结 title + spec）；agent 不可用回退取首行当 title。
  2. createRequirement({ title, spec_md, project_id, codebase_id, status: 可立即执行态 })。
  3. 起任务并双向回填：startTaskFromTemplate({ reqId, requirement, workflow, codebase_id })，写 requirement.task_id + 推进 status（复用 enqueue/scheduler 投影，不新造）。
- project_id：codebase 反查 project；都没有 → 兜底项目（与迁移一致）。
- Commit：feat(core): startTaskFromPrompt 先抽需求再起任务

## Task 3: startTaskFromTemplate 强制 requirement_id

Files: `src/core/task-factory.ts`

- reqId 为空时 throw StartTaskError("任务必须挂在一个需求下")，不再 `?? null`。
- createTask 的 requirementId 改为 opts.reqId（已非空）。
- 找所有直接调且不传 reqId 的地方，改走 Task 2 helper 或显式传。
- Commit：feat(core): 任务创建强制 requirement_id（应用层）

## Task 4: 收口 RPC 与 CLI 入口

Files: `src/daemon/rpc-methods.ts`（tasks.start / tasks.startAdHoc）、`src/cli/index.ts`（task start / start）

- startAdHoc 改调 startTaskFromPrompt；description 文案改"自动抽需求 + 立即执行"。
- tasks.start：无 reqId 但带 prompt/title → 走 startTaskFromPrompt；带 reqId → 原路径。
- CLI task start 无 -r → prompt→需求→任务；-r 显式 → 原路径。参数/退出码不变。
- smoke-test 通过。
- Commit：feat(cli/daemon): 起任务入口统一先有需求

## Task 5: 迁移 023 回填历史游离任务的需求

Files: 新增 `src/migrations/023-backfill-orphan-task-requirements.ts`

- 参考 019 风格，纯 INSERT/UPDATE，幂等（只处理 requirement_id IS NULL），不动列约束、不 DROP 表。
- 步骤：1) 确保兜底项目存在；2) 子 task 继承父 requirement_id；3) 顶层游离 task 各建需求（title=task.title，spec 从 extra.requirement，project_id=兜底/反查），状态与 task 终态对齐，双向回填。
- 写 tests/migration-023.test.ts（游离→有需求 / 子继承父 / 幂等）。
- Commit：feat(migrate): 023 回填历史游离任务需求

## Task 6: 修测试 + 全量回归

Files: tests/*

- 直接建 task 不带需求的测试辅助统一改"先建需求再建 task"（或加 makeTaskWithReq()）。
- bun test 全绿；typecheck；smoke-test。
- Commit：test: 适配任务必有需求

---

## 不做（Phase 2，单独评估）

- DB 层 requirement_id NOT NULL + FK（表重建，不可回退）。先 dogfood，加 doctor 检查告警残留游离。
- requirement↔task 状态投影 helper 集中化。
- 未来"失败重跑生成新执行"→ 升级 1:N。

## 回退

Phase 1 全是应用层 + 可回退迁移（不改列约束）。回退=还原 task-factory 强制 + 入口路由；回填的需求无害留存。
