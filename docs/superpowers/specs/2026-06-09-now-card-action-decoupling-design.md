# RO-1：/now 卡片动作客户端无关化 — 设计稿

> 来源：architect subagent 对 backlog RO-1 的设计（2026-06-09），主 agent 核实后修正。未排实施计划。
> 实施前用 writing-plans 拆 TDD 任务。

**目标**：把内核 `src/core/` 里 now CardSource 硬编码的 **Web SPA href + 中文 UI 文案 + HTTP 传输路径**收口，改成内核只出**语义化 intent**、各客户端翻译落点——落实 CLAUDE.md 第一性红线「内核不为某个 UI 妥协命名，客户端层负责翻译」。

**红线对齐**：内核掌握「能做什么」的完整集合，UI 只是 affordance；Web=决策台一等公民、CLI=与内核 1:1 一等公民、TUI=observer-only 二等公民（不追功能对等）。

---

## 0. 核实结论（含对 architect 原稿的两处修正）

主 agent 逐条核实 architect findings 后：

**确认成立**：
- 内核 `NowCardAction.href` 字段把「Web 路由」概念埋进契约；10 个 source 硬编码 `/tasks/${id}` / `/requirements/${id}` / `/settings?tab=providers` 等 href + 中文 label（「看 PR」「驳回」「去配置」…）。**红线违规属实。**
- **dismiss 真坏（真 bug）**：`completed.ts:21` / task-failed / stuck 的 `invoke.path = /api/now/cards/<id>/dismiss`；`NowCard.tsx:48` 用 `fetch(action.invoke.path)` 调它；但 `routes-now.ts:20,25-26` 对 `/api/now/*` 一律返 **410 Gone**（明示改用 WS RPC `now.dismissCard`）。**现在点「关闭」必报错。** RO-1 顺带修这个 bug。
- CLI `autopilot now`（cli/index.ts ~961）与 TUI NowList 都只 `.map(a=>a.label)` 打印、丢弃 href/invoke——只读装饰，不可操作。Web 是唯一真消费 action 落点的客户端。

**❌ 修正 architect 两处事实错误**：
1. **architect 称「App.tsx 没有 `/tasks/:id` 路由，task href 弹回 /now」——错。** 实测 `App.tsx:251` 有 `path="/tasks/:id" element={<TaskDetailRoute>}`。`view_task` 的 `/tasks/${id}` href **可正常跳转、没坏**。故 architect 的「附带 task-href bug」不成立，其 P1-1「task 落点之争」消解：`view_task` 直接翻成 `/tasks/${id}` 即可。
2. **architect 的 P1-2「reject 是否有内核 RPC」——已查清**：`tasks.decide`（rpc-methods.ts:1530）+ `decideTaskAction` 提供 gate 决断（含 reject）。`reject_review` 不必只靠跳转，可走 `tasks.decide`（具体 trigger/params 由 Web 翻译层定，属实施细节）。

---

## 1. NowCardAction 新协议形

### 设计原则
- 内核 action 只出 **语义 intent + 关联实体引用**，不出 href / HTTP path / RPC method / UI 文案。
- **label 文案不再由内核出**：内核出中性语义（`intent.kind` 即 key），客户端各自补展示文案（Web 中文、CLI 命令提示、TUI 只读标签）。翻译压力全挡在客户端层。
- `importance`（primary/secondary/danger）是**视觉重要性语义**（不是 UI 实现），保留在内核——它表达「这个动作多重要」，非「长什么样」。

### 类型草案（`src/core/now-types.ts`）
```typescript
export type NowActionIntent =
  // 实体导航类（只读查看，无副作用）
  | { kind: "view_task"; taskId: string }               // 看 PR/方案/错误/日志（×5 source）
  | { kind: "view_requirement"; requirementId: string } // 去看/回答/查看（×3 source）
  | { kind: "configure_providers"; provider?: string }  // provider-error「去配置」
  | { kind: "create_project" }                          // empty-state
  | { kind: "add_workspace" }                           // empty-state
  | { kind: "new_requirement" }                         // empty-state「/start」
  // 副作用动作类（有后端调用）
  | { kind: "reject_review"; taskId: string }           // await-review「驳回」
  | { kind: "retry_clarify"; requirementId: string }    // clarifier-error「重试」
  | { kind: "dismiss"; cardId: string };                // 关闭（×3 source）

export type NowActionImportance = "primary" | "secondary" | "danger";

export interface NowCardAction {
  intent: NowActionIntent;       // 内核唯一出语义
  importance: NowActionImportance;
}
```
`NowCard` 其余字段（id/priority/category/title/subtitle/detail/related/dismissable/created_at）不变。`title`/`subtitle` 仍是中文硬编码（「✓ Task #5 已完成」）——属另一层耦合，**本次范围外**（§6 YAGNI）。

### 1.2 现有 10 source → intent 完整映射（验收基线）
| source | 旧 action | 新 intent | importance |
|---|---|---|---|
| completed | 看 PR `/tasks/$id` | `view_task` | secondary |
| | 关闭（dismiss，**死路径**） | `dismiss` | secondary |
| await-review | 看方案 `/tasks/$id` | `view_task` | primary |
| | 驳回 `/tasks/$id?action=reject` | `reject_review` | danger |
| task-failed | 看错误 `/tasks/$id` | `view_task` | primary |
| | 关闭（dismiss，**死路径**） | `dismiss` | secondary |
| running | 看日志 `/tasks/$id` | `view_task` | secondary |
| stuck | 看日志 `/tasks/$id` | `view_task` | primary |
| | 关闭（dismiss，**死路径**） | `dismiss` | secondary |
| awaiting-approval | 去看 `/requirements/$id` | `view_requirement` | primary |
| open-question | 回答 `/requirements/$id` | `view_requirement` | primary |
| clarifier-error | 查看 `/requirements/$id` | `view_requirement` | primary |
| | 重试（retry-clarify，**活路径**） | `retry_clarify` | secondary |
| provider-error | 去配置 `/settings?tab=providers` | `configure_providers`(provider?) | primary |
| empty-state(no-project) | 新建项目 `/library/projects/new` | `create_project` | primary |
| empty-state(no-workspace) | 去添加 `/library` | `add_workspace` | primary |
| empty-state(no-requirement) | /start `/start` | `new_requirement` | primary |

9 个 intent kind 覆盖 16 个旧 action，无遗漏。`view_task`(×5)/`view_requirement`(×3) 去重——印证旧设计在 source 里重复硬编码同一路径。

---

## 2. 三客户端翻译层（intent → 落点，纯客户端资产，内核零 UI 知识）

| intent | Web（一等：跳转/RPC + 中文文案） | CLI（一等：可读命令提示） | TUI（二等 observer：只读标签） |
|---|---|---|---|
| `view_task` | `<Link to="/tasks/<id>">`「查看」（路由已存在✓） | 提示 `autopilot task status <id>` | 标签「task <id>」 |
| `view_requirement` | `<Link to="/requirements/<id>">`「查看」 | 提示 `autopilot req show <id>` | 标签「req <id>」 |
| `configure_providers` | `<Link to="/settings?tab=providers">`「去配置」 | 提示 `autopilot config providers` | 标签「provider <id>」 |
| `create_project` | `<Link to="/library?tab=projects">`「新建项目」 | 提示 `autopilot project create` | 标签「建项目」 |
| `add_workspace` | `<Link to="/library">`「去添加」 | 提示 `autopilot workspace create` | 标签「加工作区」 |
| `new_requirement` | `<Link to="/start">`「提需求」 | 提示 `autopilot req new` | 标签「提需求」 |
| `reject_review` | RPC `tasks.decide`(reject) 或带参跳转，「驳回」 | 提示对应命令 | 标签「待驳回(去Web)」 |
| `retry_clarify` | RPC `requirements.retryClarify`「重试」 | 提示/调 RPC | 标签「待重试(去Web)」 |
| `dismiss` | RPC `now.dismissCard`「关闭」（**修 410 bug**） | （可选 `autopilot now dismiss <id>`，§6） | 不显示（observer 不操作） |

**落地方式**：
- Web：新建 `src/web/src/lib/now-intent.ts` 导出 `resolveIntent(intent) → { label; href?; rpc? }`，用 `switch(intent.kind)` + `default: const _x: never = intent`（exhaustive 兜底，见 §5）。`NowCard.tsx` 改读它（href→`<Link>`，rpc→`requestRpc`，替代裸 `fetch`）。
- CLI/TUI：**符合二等定位，不追功能对等**。只把 intent 翻成可读标签/提示行；副作用类标「(去 Web 处理)」。

---

## 3. dismiss/传输收口（内核彻底不出传输细节）

旧 invoke 只表达「裸 HTTP method+path」，但 dismiss 的真能力在 WS RPC `now.dismissCard`、retry-clarify 才是真 HTTP。**新协议删掉 href/invoke 两个传输字段，换成 intent**——传输方式（HTTP 还是 RPC）是客户端的事，下放给翻译层：
- Web 翻 `dismiss` → `requestRpc("now.dismissCard", {id: cardId})`（已有 RPC，**直接修好 410**）。
- Web 翻 `retry_clarify` → `requestRpc("requirements.retryClarify", {id})`（已有 RPC，比裸 fetch 更一致，且顺手让这个孤儿 RPC 有 web 调用方）。

**不给 invoke 协议加「RPC method」字段**——那只是把另一个传输细节塞进内核，仍违红线。正解是内核不关心传输。`routes-now.ts` 的 410 stub 保留作历史防御（无害），但内核里再无任何东西指向 `/api/now/*`。

---

## 4. 迁移路径（双写过渡，/now 一等公民全程不失灵）

一次性删字段会让「内核已改、Web 未改」的中间提交白屏。双写让每步可独立合并、可回滚。

**阶段 1（低风险先上）：内核加 `intent`，与旧字段并存**
- `NowCardAction` = `{ intent, importance, label?, href?, invoke? }`（新字段必填，旧字段暂留可选并继续填）。
- 10 个 source 的 buildCard 同时填 intent + 旧字段。客户端不动。
- 回归网：现有 10 个 `tests/card-sources/*.test.ts` 旧断言全绿 + **新增断言每个 action 的 `intent.kind`**（钉死 §1.2 映射）。可独立合并、零客户端风险。

**阶段 2：Web 翻译层切 intent（一等公民优先）**
- 新建 `now-intent.ts`；`NowCard.tsx` 改读 intent、不再读 href/invoke；`web/src/lib/now-types.ts` 镜像加 intent。
- **此步修两 bug**：dismiss 410（改 RPC）、retry 改走 RPC。view_task 仍 `/tasks/<id>`（没坏，照旧）。
- 回归网：`bun run build:web` 通过；`bun run coverage:rpc` 确认 `now.dismissCard`/`requirements.retryClarify` 有 web 调用；`/now` 手动验收每卡可点。

**阶段 3：CLI/TUI 切 intent 出标签**（observer-only，不加操作能力）。

**阶段 4：删旧字段收尾**
- 三客户端都不读 href/invoke/label 后，从 core + web 镜像删三字段，10 source 删旧填充，10 测试删 href/invoke 断言（已被阶段 1 intent 断言取代）。红线彻底落地。

---

## 5. 回归面 + 必钉死不变式

1. **intent 完整性（最高优先）**：10 source 每个 action 的 `intent.kind` 对齐 §1.2。建议新增 `tests/now-intent-coverage.test.ts` 集中扫 scan 输出断言覆盖，或各 source 测试内加断言。
2. **Web 翻译完整性（编译期硬保证）**：`resolveIntent` 用 `switch + default: const _:never = intent` —— 新增 intent kind 忘了在 Web 登记会 **typecheck 失败**。比测试更硬。
3. **dismiss 真能用**：`tests/routes-now.test.ts`（dismiss RPC）保持绿。
4. **retry 不回归**：`tests/routes-clarifier.test.ts` 保持绿。
5. **coverage:rpc 纳入每阶段验收**：确认没把活 RPC 调成孤儿、没新增孤儿；`requirements.retryClarify` 从孤儿变 web 有调用（消一个死代码告警）。

每阶段验收：`bun test` 0 fail + `bun run typecheck` + （动前端的阶段）`bun run build:web` + `bun run coverage:rpc` 无新增孤儿。

---

## 6. YAGNI 边界 + 残留待定项

**明确不做**：
1. CLI 不为每个 now intent 出可执行二级命令（now 是观察聚合视图，不是新命名空间；用户走既有 `task status`/`req`/`project create`）。唯一可选：`autopilot now dismiss <cardId>`（调已有 RPC，零内核改动，nice-to-have 不阻塞）。
2. TUI 不加操作能力（observer-only，副作用 intent 出「(去 Web 处理)」）。
3. **不动 title/subtitle 中文硬编码**——是另一个 backlog 项（title i18n），单开发者全中文场景纯理论收益，明确范围外防 scope creep。
4. 不给 invoke 加 RPC method 字段（§3 已论证）。

**残留待定（实施阶段 2 前定，均属 Web 翻译细节、不影响协议）**：
- `reject_review` → `tasks.decide` 的具体 trigger/params（已确认 RPC 存在，差参数映射）。
- `configure_providers` 的可选 `provider` 字段 Web 是否真用来高亮——用则保留，不用可退化成无参（P2，可 YAGNI 删）。

---

## 相关文件
**内核（改）**：`src/core/now-types.ts` + `src/core/card-sources/{completed,await-review,task-failed,running,stuck,awaiting-approval,open-question,clarifier-error,provider-error,empty-state}.ts`（10 个）
**翻译/客户端（改/增）**：`src/web/src/lib/now-types.ts`、**新增** `src/web/src/lib/now-intent.ts`、`src/web/src/components/NowCard.tsx`、`src/tui/components/NowList.tsx`、`src/cli/index.ts`(now 命令)
**不变式锚点（不改）**：`src/daemon/rpc-methods.ts`（`now.cards`/`now.dismissCard`/`requirements.retryClarify`/`tasks.decide` 已存在，翻译复用，零内核新增）、`src/daemon/routes-now.ts`（410 stub 保留）、`src/core/now-aggregator.ts`/`now-dismiss.ts`
**测试（改/增）**：`tests/card-sources/*.test.ts`（10 个）、**新增** `tests/now-intent-coverage.test.ts`、`tests/routes-now.test.ts`/`tests/routes-clarifier.test.ts`（保持绿）
