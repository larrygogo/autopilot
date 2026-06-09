# RO-1：/now 卡片动作客户端无关化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内核 now CardSource 不再硬编码 Web href / 中文 label / HTTP 传输路径，改成只出语义 `intent`，客户端各自翻译落点——落实「内核不为某 UI 妥协命名」红线，顺带修 dismiss 410 bug。

**Architecture:** `NowCardAction` 从 `{label, kind, href|invoke}` 改成 `{intent: NowActionIntent, kind}`（`kind`=视觉重要性，已是中性语义，**保留不改名**；删 label/href/invoke 这三个 UI/传输字段）。双写四阶段迁移：阶段 1 内核加 `intent` 与旧字段并存（每步 typecheck 绿）→ 阶段 2 Web 切 intent（修 dismiss 410）→ 阶段 3 CLI/TUI 切 intent → 阶段 4 删旧字段。

**Tech Stack:** Bun + TypeScript strict；测试 `bun:test`；Web React。

**对设计稿的偏离**：设计稿把 `kind` 改名 `importance`——本计划**不改名**（`kind` 已是中性 primary/secondary/danger 语义、不违红线，改名是纯 churn 触及所有客户端）。其余遵循设计稿 `docs/superpowers/specs/2026-06-09-now-card-action-decoupling-design.md`。

---

## intent 完整映射（验收基线，已逐 source 核实）
| source | action | 旧 | intent | kind |
|---|---|---|---|---|
| completed | 看 PR | href `/tasks/$id` | `{kind:"view_task",taskId}` | secondary |
| | 关闭 | invoke dismiss | `{kind:"dismiss",cardId}` | secondary |
| await-review | 看方案 | href `/tasks/$id` | `view_task` | primary |
| | 驳回 | href `/tasks/$id?action=reject` | `{kind:"reject_review",taskId}` | danger |
| task-failed | 看错误 | href `/tasks/$id` | `view_task` | primary |
| | 关闭 | invoke dismiss | `dismiss` | secondary |
| running | 看日志 | href `/tasks/$id` | `view_task` | secondary |
| stuck | 看日志 | href `/tasks/$id` | `view_task` | primary |
| | 关闭 | invoke dismiss | `dismiss` | secondary |
| awaiting-approval | 去看 | href `/requirements/$id` | `{kind:"view_requirement",requirementId}` | primary |
| open-question | 回答 | href `/requirements/$reqId` | `view_requirement` | primary |
| clarifier-error | 查看 | href `/requirements/$reqId` | `view_requirement` | primary |
| | 重试 | invoke retry-clarify | `{kind:"retry_clarify",requirementId}` | secondary |
| provider-error | 去配置 | href `/settings?tab=providers` | `{kind:"configure_providers",provider?}` | primary |
| empty-state(no-project) | 新建项目 | href `/library/projects/new` | `{kind:"create_project"}` | primary |
| empty-state(no-workspace) | 去添加 | href `/library` | `{kind:"add_workspace"}` | primary |
| empty-state(no-requirement) | /start | href `/start` | `{kind:"new_requirement"}` | primary |

`dismiss` 的 `cardId` = 卡片 `id` 字段（如 `completed:${task.id}`）。

---

## 阶段/Task 1：内核加 intent（双写，10 source + 类型 + 完整性测试）

**Files:** Modify `src/core/now-types.ts` + `src/core/card-sources/{completed,await-review,task-failed,running,stuck,awaiting-approval,open-question,clarifier-error,provider-error,empty-state}.ts`；Create `tests/now-intent-coverage.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/now-intent-coverage.test.ts`：
```ts
import { describe, it, expect } from "bun:test";
import type { NowActionIntent } from "../src/core/now-types";

// 已知 intent kind 全集（与 now-types.ts NowActionIntent 同步）
const KNOWN_KINDS = new Set([
  "view_task", "view_requirement", "configure_providers",
  "create_project", "add_workspace", "new_requirement",
  "reject_review", "retry_clarify", "dismiss",
]);

// 构造各 source 的 buildCard 不易（依赖 DB），这里改为静态断言：每个 intent kind 都被
// KNOWN_KINDS 覆盖，且类型上 NowActionIntent 是可辨识联合。运行时完整性靠各 source 测试 +
// 下面的类型守卫测试。
describe("now intent 完整性", () => {
  it("每个 intent kind 可构造且在已知集合内", () => {
    const samples: NowActionIntent[] = [
      { kind: "view_task", taskId: "t1" },
      { kind: "view_requirement", requirementId: "r1" },
      { kind: "configure_providers" },
      { kind: "create_project" },
      { kind: "add_workspace" },
      { kind: "new_requirement" },
      { kind: "reject_review", taskId: "t1" },
      { kind: "retry_clarify", requirementId: "r1" },
      { kind: "dismiss", cardId: "completed:t1" },
    ];
    for (const s of samples) expect(KNOWN_KINDS.has(s.kind)).toBe(true);
    expect(samples.length).toBe(KNOWN_KINDS.size); // 样本覆盖全部 kind
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/now-intent-coverage.test.ts`
Expected: FAIL —— `NowActionIntent` 类型不存在（import 解析/类型报错）。

- [ ] **Step 3: 改 now-types.ts 加 intent（与旧字段并存）**

`src/core/now-types.ts`，在 `NowCardActionKind` 之后加 `NowActionIntent`，并给 `NowCardAction` 两个分支都加 `intent` 必填字段（旧 label/kind/href/invoke 保留）：
```ts
export type NowCardActionKind = "primary" | "secondary" | "danger";

export type NowActionIntent =
  | { kind: "view_task"; taskId: string }
  | { kind: "view_requirement"; requirementId: string }
  | { kind: "configure_providers"; provider?: string }
  | { kind: "create_project" }
  | { kind: "add_workspace" }
  | { kind: "new_requirement" }
  | { kind: "reject_review"; taskId: string }
  | { kind: "retry_clarify"; requirementId: string }
  | { kind: "dismiss"; cardId: string };

export type NowCardAction =
  | {
      label: string;
      kind: NowCardActionKind;
      /** @deprecated 阶段 4 删；客户端改用 intent 翻译 */
      href: string;
      invoke?: never;
      intent: NowActionIntent;
    }
  | {
      label: string;
      kind: NowCardActionKind;
      /** @deprecated 阶段 4 删 */
      invoke: { method: "POST" | "PATCH"; path: string; body?: unknown };
      href?: never;
      intent: NowActionIntent;
    };
```
> 注意 `NowActionIntent` 的 `kind` 与 `NowCardActionKind` 同名属性但不同类型——前者是 intent 判别符、后者是视觉重要性，分属 `action.intent.kind` 与 `action.kind`，无冲突。

- [ ] **Step 4: 10 source 的 buildCard 每个 action 加 intent（旧字段不动）**

逐文件改（只加 `intent:`，其余保留）。**completed.ts**：
```ts
    actions: [
      { label: "看 PR", kind: "secondary", href: `/tasks/${task.id}`, intent: { kind: "view_task", taskId: task.id } },
      { label: "关闭", kind: "secondary", invoke: { method: "POST", path: `/api/now/cards/completed:${task.id}/dismiss` }, intent: { kind: "dismiss", cardId: `completed:${task.id}` } },
    ],
```
**await-review.ts**（看方案 + 驳回）：给 `看方案` 加 `intent: { kind: "view_task", taskId: task.id }`；给 `驳回` 加 `intent: { kind: "reject_review", taskId: task.id }`。
**task-failed.ts**：`看错误` 加 `intent: { kind: "view_task", taskId: task.id }`；`关闭` 加 `intent: { kind: "dismiss", cardId: \`task-failed:${task.id}\` }`。
**running.ts**：`看日志` 加 `intent: { kind: "view_task", taskId: task.id }`。
**stuck.ts**：`看日志` 加 `intent: { kind: "view_task", taskId: taskId }`；`关闭` 加 `intent: { kind: "dismiss", cardId: \`stuck:${taskId}\` }`。
**awaiting-approval.ts**：`去看` 加 `intent: { kind: "view_requirement", requirementId: req.id }`。
**open-question.ts**：`回答` 加 `intent: { kind: "view_requirement", requirementId: row.req_id }`。
**clarifier-error.ts**：`查看` 加 `intent: { kind: "view_requirement", requirementId: reqId }`；`重试` 加 `intent: { kind: "retry_clarify", requirementId: reqId }`。
**provider-error.ts**：`去配置` 加 `intent: { kind: "configure_providers", provider: <related.id 若有，否则省略> }`（若该 source 有 provider id 变量则传，无则 `{ kind: "configure_providers" }`）。
**empty-state.ts**：`新建项目` 加 `intent: { kind: "create_project" }`；`去添加` 加 `intent: { kind: "add_workspace" }`；`/start` 加 `intent: { kind: "new_requirement" }`。

> 每个 source 用 Read 看清 buildCard 里实体 id 的实际变量名（task.id / taskId / req.id / row.req_id / reqId）后再填，别假设。

- [ ] **Step 5: 跑测试 + typecheck**

Run: `bun test tests/now-intent-coverage.test.ts && bun run typecheck`
Expected: 测试 PASS；typecheck 0 错误（旧字段还在，3 客户端不破）。

- [ ] **Step 6: 全量测试（确认 10 source 旧测试没被 intent 必填字段破坏）**

Run: `bun test`
Expected: 全绿。若某 source 测试用对象字面量比对整个 action（`toEqual`）会因多了 intent 字段失败——若失败，更新该断言加上 intent（属预期，intent 是新增契约）。

- [ ] **Step 7: 提交**
```bash
git add src/core/now-types.ts src/core/card-sources/*.ts tests/now-intent-coverage.test.ts
git commit -m "feat(core): RO-1 阶段1 now CardAction 加语义 intent（与旧字段双写）"
```

---

## 阶段/Task 2：Web 切 intent + 修 dismiss 410 bug

**Files:** Modify `src/web/src/lib/now-types.ts`、`src/web/src/components/NowCard.tsx`；Create `src/web/src/lib/now-intent.ts`

- [ ] **Step 1: web 镜像类型加 intent**

`src/web/src/lib/now-types.ts` 加 `NowActionIntent`（与 core 同定义）+ `NowCardAction` 两分支加 `intent: NowActionIntent`（旧字段保留）。照搬阶段 1 Step 3 的类型块。

- [ ] **Step 2: 新建 Web 翻译层（exhaustive switch）**

Create `src/web/src/lib/now-intent.ts`：
```ts
import type { NowActionIntent } from "./now-types";

export interface ResolvedAction {
  label: string;
  href?: string;                                  // 跳转类
  rpc?: { method: string; params: Record<string, unknown> }; // 副作用类
}

/** intent → Web 落点 + 中文文案（客户端翻译层，内核零 UI 知识的对侧） */
export function resolveIntent(intent: NowActionIntent): ResolvedAction {
  switch (intent.kind) {
    case "view_task":          return { label: "查看", href: `/tasks/${intent.taskId}` };
    case "view_requirement":   return { label: "查看", href: `/requirements/${intent.requirementId}` };
    case "configure_providers":return { label: "去配置", href: "/settings?tab=providers" };
    case "create_project":     return { label: "新建项目", href: "/library?tab=projects" };
    case "add_workspace":      return { label: "去添加", href: "/library" };
    case "new_requirement":    return { label: "提需求", href: "/start" };
    case "reject_review":      return { label: "驳回", href: `/tasks/${intent.taskId}?action=reject` };
    case "retry_clarify":      return { label: "重试", rpc: { method: "requirements.retryClarify", params: { id: intent.requirementId } } };
    case "dismiss":            return { label: "关闭", rpc: { method: "now.dismissCard", params: { id: intent.cardId } } };
    default: { const _x: never = intent; return _x; } // 新增 intent 忘登记 → 编译失败
  }
}
```
> `reject_review` 暂保留带参跳转（与旧 `?action=reject` 行为一致，落地页处理）——设计稿 §6 留的 Web 翻译细节，先不改成 RPC（`tasks.decide` 参数映射另议），intent 抽象不变。

- [ ] **Step 3: 确认 web 调 RPC 的方式**

用 Read 看 `src/web/src/hooks/useApi.ts` 里 `requestRpc` 的签名/导出（RO-1 spec 提到全栈走 `requestRpc<T>(method, params)`）。NowCard 将 import 它来执行 `rpc` 类 intent。

- [ ] **Step 4: NowCard.tsx 改读 intent**

`src/web/src/components/NowCard.tsx`：import `resolveIntent` 和 `requestRpc`（从 useApi）。把 actions 渲染改成基于 `resolveIntent(action.intent)`：`href` → `<Link to={r.href}>{r.label}</Link>`；`rpc` → 按钮 onClick `await requestRpc(r.rpc.method, r.rpc.params)` + busy 态 + toast（替代现有 `fetch(action.invoke.path)`——**这步修 dismiss 410**）。`variant` 仍用 `action.kind`。删掉旧的 `handleInvoke`/`action.href`/`action.invoke` 读取。

> 关键：dismiss 现在走 `requestRpc("now.dismissCard", {id})` 而非 `fetch(/api/now/.../dismiss)`（410）。dismiss 成功后卡片需从列表移除——确认 now 页是否靠 WS `now:*` 推送自动移除（多半是），若是则 RPC 成功即可，无需手动改本地 state。

- [ ] **Step 5: typecheck + build:web + 全量测试**

Run: `bun run typecheck && bun run build:web && bun test`
Expected: 全绿。exhaustive switch 保证每个 intent 都翻译了。

- [ ] **Step 6: 提交**
```bash
git add src/web/src/lib/now-types.ts src/web/src/lib/now-intent.ts src/web/src/components/NowCard.tsx
git commit -m "feat(web): RO-1 阶段2 NowCard 改读 intent + dismiss 改走 RPC（修 410）"
```

---

## 阶段/Task 3：CLI/TUI 切 intent（observer-only，只读标签）

**Files:** Modify `src/tui/components/NowList.tsx`、`src/cli/index.ts`（now 命令）

- [ ] **Step 1: 写 intent→标签函数（共用或各自）**

在 TUI/CLI 各自处加一个 `intentToLabel(intent): string`（observer 只需可读标签，不需落点）：
```ts
function intentToLabel(i: NowActionIntent): string {
  switch (i.kind) {
    case "view_task": return `task ${i.taskId}`;
    case "view_requirement": return `req ${i.requirementId}`;
    case "configure_providers": return "去配置 provider";
    case "create_project": return "新建项目";
    case "add_workspace": return "加工作区";
    case "new_requirement": return "提需求";
    case "reject_review": return "待驳回(去 Web)";
    case "retry_clarify": return "待重试(去 Web)";
    case "dismiss": return "关闭(去 Web)";
    default: { const _x: never = i; return _x; }
  }
}
```

- [ ] **Step 2: 改 NowList.tsx + cli now**

用 Read 看两处当前怎么用 `a.label`（TUI NowList ~57 `card.actions.map(a=>a.label)`；CLI `now` 命令 ~961 同款）。改成 `card.actions.map(a => intentToLabel(a.intent))`。import `NowActionIntent` 类型。

- [ ] **Step 3: typecheck + 全量测试 + 提交**
```bash
bun run typecheck && bun test
git add src/tui/components/NowList.tsx src/cli/index.ts
git commit -m "refactor(tui+cli): RO-1 阶段3 now 列表改读 intent 出只读标签"
```

---

## 阶段/Task 4：删旧字段（label/href/invoke）收尾——红线彻底落地

**Files:** Modify `src/core/now-types.ts`、`src/web/src/lib/now-types.ts`、`src/core/card-sources/*.ts`（10 个）、`tests/card-sources/*.test.ts`（10 个，删 href/invoke/label 断言）

- [ ] **Step 1: 删类型旧字段**

`src/core/now-types.ts` + `src/web/src/lib/now-types.ts`：`NowCardAction` 改成单一形（不再是 href/invoke 判别联合）：
```ts
export interface NowCardAction {
  intent: NowActionIntent;
  kind: NowCardActionKind; // 视觉重要性（中性语义，保留）
}
```

- [ ] **Step 2: 10 source 删 label/href/invoke**

每个 buildCard 的 action 只留 `{ intent, kind }`。如 completed.ts：
```ts
    actions: [
      { kind: "secondary", intent: { kind: "view_task", taskId: task.id } },
      { kind: "secondary", intent: { kind: "dismiss", cardId: `completed:${task.id}` } },
    ],
```
其余 9 source 同样删 label/href/invoke。

- [ ] **Step 3: typecheck 找漏网消费方**

Run: `bun run typecheck`
Expected: 0 错误。**若报 `action.href`/`action.label`/`action.invoke` 不存在 → 说明某客户端阶段 2/3 没切干净，回去补。** 这是删旧字段的安全网。

- [ ] **Step 4: 更新 10 source 测试删旧断言**

`tests/card-sources/*.test.ts` 里断言 `a.href === ...` / `a.invoke.path === ...` / `a.label === ...` 的删掉或改成断言 `a.intent`（阶段 1 已加 intent 断言则直接删旧）。

- [ ] **Step 5: 全量验证 + 提交**
```bash
bun run typecheck && bun test && bun run build:web
git add src/core/now-types.ts src/web/src/lib/now-types.ts src/core/card-sources/*.ts tests/card-sources/*.test.ts
git commit -m "refactor(core): RO-1 阶段4 删 now CardAction 的 label/href/invoke，内核零 UI 文案/路由"
```
Expected: 全绿。内核 `now-types.ts` 再无 href/label/invoke，红线落地。

---

## 收尾
四阶段完成后用 superpowers:finishing-a-development-branch。跑 `bun run coverage:rpc` 确认 `now.dismissCard` / `requirements.retryClarify` 有 web 调用方、无新增孤儿。
遗留（范围外，§6 YAGNI）：title/subtitle 中文硬编码 i18n、CLI now 二级操作命令、reject_review 改 RPC、`autopilot now dismiss`。

## Self-Review
**1. Spec coverage**：NowActionIntent 协议（阶段1）+ 三客户端翻译（阶段2/3）+ dismiss 收口走 RPC（阶段2 修 410）+ 删旧字段红线落地（阶段4）+ exhaustive switch 回归（阶段2/3 default:never）+ intent 完整性测试（阶段1）。设计稿 §1-5 全覆盖。偏离：`kind` 不改名 `importance`（已说明）。
**2. Placeholder scan**：阶段1 Step4 / 阶段2 Step3-4 / 阶段3 Step2 让实施者「用 Read 看清实际变量名/调用方式再填」——这不是占位符而是**防臆断指令**（本计划已给出每 source 的 intent 值，变量名需现读现核因 source 间不统一 task.id/taskId/req.id）。其余步骤均给完整代码。
**3. Type consistency**：`NowActionIntent` 9 kind 跨 core/web 镜像/CLI/TUI 一致；`resolveIntent`/`intentToLabel` 的 switch case 与类型定义对齐 + `default:never` 编译期兜底；`dismiss.cardId` = 卡片 id（`<source>:<entity-id>`）跨阶段一致。
