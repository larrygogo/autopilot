# 需求详情页「状态步骤 Tab」改造 — 设计文档

- 日期：2026-06-10
- 状态：已与用户对齐方向，待 spec 复核
- 影响范围：Web UI，纯前端（无后端 / RPC / DB 改动）

## 背景与现状

需求详情页 `src/web/src/pages/RequirementDetail.tsx` 当前用 `StageRail`（5 个粗粒度阶段：澄清 / 待发 / 执行 / 验收 / 完成）做进度可视化，主区按 `stage` 条件渲染「当前阶段」的内容（`statusToStage(status)` → stage，渲染逻辑约在 1283–1457 行）。用户**只能看到当前阶段**的内容，无法点击回看其它阶段。

需求共 11 个 status（含互斥分支）：
`drafting → clarifying → ready / awaiting_approval → queued → running → awaiting_review → fix_revision → done`，外加终态 `failed / cancelled`。

## 目标

把进度可视化改成**可点击的步骤式 Tab**：每个步骤一个 tab，点击切换查看该步骤的内容；默认进入显示「当前正在进行」的步骤；每个步骤展示其状态下的内容。

## 设计决策（已与用户确认）

### D1. 粒度：6 个关键步骤

11 个 status 中有互斥分支（就绪/待审是分支、完成/失败/取消是三选一终态），字面铺成 11 个 tab 会出现"永远点不到"的并列态。因此按主线流程合并为 **6 个步骤**，分支/终态并入对应步骤：

| 步骤 | 含的 status |
|---|---|
| ① 澄清 | `drafting` / `clarifying` |
| ② 审批 | `ready` / `awaiting_approval` |
| ③ 排队 | `queued` |
| ④ 执行 | `running` / `fix_revision` |
| ⑤ 验收 | `awaiting_review` |
| ⑥ 完成 | `done` / `failed` / `cancelled`（按实际态变色） |

> 与现有 `statusToStage`（5 阶段）的差异：把 `queued` 从「待发」里**单独拆出**为「排队」步骤；其余基本对应。

### D2. 点击行为：全可点，三态

所有步骤都可点击。按所选步骤相对「当前步骤」的位置分三种表现：

| 所选步骤 | 表现 |
|---|---|
| **当前步骤** | 该状态完整内容 **+ 可操作按钮**（审批步的批准/驳回、验收步的合并/要求修改、执行步的注入反馈等）—— 即现有 stage 渲染逻辑 |
| **已走过步骤** | 该步**历史内容，只读**（回看澄清问答、当时的 spec、排队/执行记录），**不显示操作按钮** |
| **未到达步骤** | **占位提示**（如「完成前序步骤后进入此步」） |

### D3. 默认选中与跟随

- 进页面**默认选中 `statusToStep(req.status)` 对应的当前步骤**。
- status 变化（WebSocket 推送 `requirement:*` 的 `status-changed`）时：
  - 若用户**未手动切走**（选中步骤 == 旧的当前步骤）→ 自动跟随到新的当前步骤。
  - 若用户**正在回看历史步骤**（手动切走了）→ **不打断**，在内容区顶部给一个「↩ 回到当前步骤」提示按钮。

### D4. 布局整合

- 新的步骤条**替代** `StageRail`（不与旧进度条并存）。
- `NextStepCTA`（下一步主操作 banner）**保留在步骤条上方**，始终提示"当前该做什么"，不随选中 tab 变化。
- 右侧栏（元信息卡、spec 卡、危险区）**保持不变**。

### D5. 视觉

- 6 步采用**圆圈数字 + 连接线**的步进样式（沿用 `StageRail` 的视觉语言），叠加：可点击、选中态（高亮/下划线）。
- 步骤三态配色：**已完成**（实心/勾）·**当前**（primary 高亮）·**未到达**（浅灰）；`failed` / `cancelled` 时「完成」步标红。

## 组件与改动

纯前端，无需改后端（spec、questions、sub_prs、task record 等内容现有 RPC 已返回）。

1. **新增 `statusToStep(status)` 映射**
   - 返回 6 步之一的 step id（如 `clarify` / `approve` / `queue` / `execute` / `review` / `done`）。
   - 放在与 `statusToStage` 同处（`StageRail.tsx` 或抽到共享 util），供页面与步骤条共用。

2. **新增 `StepBar` 组件**（`src/web/src/components/StepBar.tsx`，presentational）
   - Props：`steps`（每步含 `id` / `label` / `state: done|current|future` / `tone`）、`selectedStep`、`onSelect(stepId)`。
   - 渲染可点击的圆圈数字步进条，复用 StageRail 视觉。**不含业务逻辑**，纯展示 + 回调。

3. **改造 `RequirementDetail.tsx`**
   - 新增本地状态 `selectedStep`，初值 `statusToStep(req.status)`；按 D3 处理默认与跟随。
   - 用 `StepBar` 替换 `StageRail` 的使用（约 1261–1264 行）。
   - 把现有按 `stage` 的条件渲染（约 1283–1457 行）重构为**按 `selectedStep` 渲染**：
     - `selectedStep === 当前步骤` → 渲染现有 actionable 内容（保持原有按钮/handler）。
     - `selectedStep` 在当前步骤**之前** → 渲染该步只读历史内容（复用相同卡片，去掉操作按钮）。
     - `selectedStep` 在当前步骤**之后** → 渲染占位提示。
   - 步骤先后顺序用一个固定的 step 顺序数组 `STEP_ORDER` 判断 before/after。

## 数据流

- 数据来源不变：`refresh()` 仍并行拉 `getRequirement` / `listWorkspaces` / `listRequirementSubPrs` / `listQuestions` / `getClarifierRound`（RequirementDetail.tsx:439–449）。
- WebSocket 订阅不变；仅在 `status-changed` 时按 D3 调整 `selectedStep`。

## 测试

- 现有 Web 测试以组件/工具函数为主。新增：
  - `statusToStep` 的单元测试：11 个 status → 正确的 6 步映射（含 `failed`/`cancelled` → 完成步）。
  - `StepBar` 的渲染测试：done/current/future 三态样式、点击触发 `onSelect`、未到达步可点。
  - 跟随逻辑：模拟 status 变化时 `selectedStep` 在「未手动切走 → 跟随」「已手动切走 → 不打断」两种情形下的行为（可对相关纯函数/hook 做单测）。
- 不引入后端测试（无后端改动）。

## 不在本次范围（YAGNI）

- 不改任何 RPC / DB / 状态机。
- 不新增「未到达步骤的引导预览文案」（D2 选了占位提示，非预览）。
- 不动右侧栏与 `NextStepCTA` 的内部逻辑。
- 不为 11 个 status 各做一个 tab。
