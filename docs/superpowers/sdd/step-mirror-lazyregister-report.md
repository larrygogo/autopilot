# mirror-pusher 懒注册自愈修复报告

## 问题

`MirrorPusher._byAutopilotId` 仅在两个时机建立内存映射：
1. assignments-poller 创建需求时（`registerLink`）
2. daemon 重启 `recoverInflightLinks`（只恢复非终态需求）

若某需求在 daemon 启动时处于 `failed`（终态），被排除在恢复之外；之后若被重跑进入 `running`，其 link 不在内存 → 事件被静默丢弃 → reqgenie mirror 停止更新。

## 解决方案：懒注册自愈

新增 `private ensureRegistered(autopilotReqId: string): boolean`：
- 已在 `_byAutopilotId` 中 → 直接返回 `true`（快路径，无 DB 查询）
- 不在 → 调 `deps.getRequirement` 查 DB → 若 `source=reqgenie && external_ref` 非空：
  - 调 `registerLink` 注册映射
  - `void pushSnapshot(...)` fire-and-forget 全量快照重置基线
  - 返回 `true`
- 非 reqgenie → 返回 `false`

## 变更点

### `mirror-pusher.ts`
- `RequirementSnapshot` 新增 `source?: string | null` 和 `external_ref?: string | null`
- 新增 `ensureRegistered` 私有方法
- 6 个需求级事件处理器将 `!this._byAutopilotId.has(id)` 换为 `!this.ensureRegistered(id)`：
  - `handleStatusChanged`
  - `handleQuestionsUpdated`
  - `handleQuestionResolved`
  - `handleActiveQuestionChanged`
  - `handleSpecRevised`
  - `handleClarifierRoundUpdate`
- `resolveByTaskId`（phase/task 事件共用）在找到 reqId 后调 `ensureRegistered(reqId)`，覆盖全部 phase 处理器

### `index.ts`
- `getRequirement` 工厂新增 `source: req.source` 和 `external_ref: req.external_ref` 映射

### `mirror-pusher.test.ts`（新建）
3 个测试用例：
1. 未映射 reqgenie 需求收事件 → 自动注册 + 推快照 + 事件入队
2. 非 reqgenie 需求 → 不注册、不推快照、不入队
3. 已映射需求 → 不重复查 DB，不重推快照

## 测试结果
- `bun run typecheck`：通过（无 TS 错误）
- `bun test`：1766 pass，0 fail
