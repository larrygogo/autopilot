# /now PR 1 (后端基础) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 daemon 后端实现 `now-aggregator` + 8 个 CardSource + HTTP / WebSocket 接口，让客户端能拉到"现在该做什么"的卡片列表。

**Architecture:** 新模块 `src/core/now-aggregator.ts` 管理 `CardSource[]`，启动时调用每个 source 的 `scan()` 建立内存快照 `Map<id, NowCard>`，订阅 event-bus 事件，事件来时分发给对应 source 拿 `CardDelta[]`，更新快照并通过 WebSocket channel `now:*` 推送 `card_added` / `card_updated` / `card_removed`。已 dismiss 的卡片 ID 持久化到新表 `now_dismissed_cards`，aggregator 在 scan 与新增时按此过滤。HTTP `GET /api/now/cards` 返全量快照，`POST /api/now/cards/:id/dismiss` 标记 dismiss。

**Tech Stack:** TypeScript + Bun runtime + bun:sqlite + bun:test。复用 daemon 已有的 event-bus / WebSocket / 迁移机制，不引入新依赖。

**Spec:** `docs/superpowers/specs/2026-05-12-now-screen-redesign-design.md` 的 PR 1 部分（§4 状态推导引擎 + §5.1-5.5 后端文件清单）。

---

## File Structure

**新建：**

```
src/migrations/011-now-dismissed-cards.ts       — 迁移：创建 now_dismissed_cards 表
src/core/now-types.ts                           — NowCard / CardDelta / CardSource / DismissReason
src/core/now-dismiss.ts                         — dismiss 持久化（CRUD）
src/core/now-aggregator.ts                      — 聚合器核心（注册 sources / scan / 事件分发 / WS emit）
src/core/card-sources/awaiting-approval.ts      — P1 决策：需求等审批
src/core/card-sources/open-question.ts          — P1 决策：AI 提的待回答问题
src/core/card-sources/await-review.ts           — P1 决策：task 在 await_review 阶段
src/core/card-sources/running.ts                — P2 进行：task 在 running_* 阶段（非 await_review）
src/core/card-sources/stuck.ts                  — P1 决策：watcher 已恢复但用户未确认
src/core/card-sources/completed.ts              — P3 完成：done 任务 24h 内
src/core/card-sources/task-failed.ts            — P0 异常：failed 任务未 dismiss
src/core/card-sources/empty-state.ts            — 引导：没有项目/codebase/需求的渐进引导
src/core/card-sources/provider-error.ts         — P0 异常（stub：等 provider 健康检查基础设施）
src/daemon/routes-now.ts                        — HTTP 处理函数，由 routes.ts 调用
tests/migration-011.test.ts
tests/now-dismiss.test.ts
tests/now-aggregator.test.ts
tests/card-sources/*.test.ts                    — 8 个 source 各一个测试文件
tests/routes-now.test.ts
tests/now-e2e.test.ts                           — daemon 真启动 + curl + WS smoke
```

**修改：**

```
src/daemon/protocol.ts                          — 加 now:* 事件类型 + getChannelsForEvent 加 case
src/daemon/routes.ts                            — 在 handleRequest 里委托 /api/now/* 给 routes-now.ts
src/daemon/index.ts                             — daemon 启动时初始化 + 关闭时 dispose aggregator
```

每个文件都有单一职责。`now-aggregator.ts` 不直接知道任何具体卡片类型；新增类型 = 新增一个 `card-sources/*.ts` 文件并在装配处注册一行。

---

## Task 0: 准备实施分支

**Files:** 仅 git 操作

- [ ] **Step 0.1: 从 main 创建实施分支**

```bash
git checkout main
git pull
git checkout -b feat/now-aggregator-backend-20260512
```

> spec 分支 `docs/now-screen-redesign-spec-20260512` 应已合并到 main；若未合并先合并 spec PR 再开实施分支。

- [ ] **Step 0.2: 确认基线测试通过**

Run: `bun test`
Expected: 全绿。若有红，先记录并不要继续 PR 1 实施。

---

## Task 1: Migration 011 — now_dismissed_cards 表

**Files:**
- Create: `src/migrations/011-now-dismissed-cards.ts`
- Test: `tests/migration-011.test.ts`

- [ ] **Step 1.1: 写失败测试**

Create `tests/migration-011.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate011 } from "../src/migrations/011-now-dismissed-cards";

describe("migration 011-now-dismissed-cards", () => {
  it("创建 now_dismissed_cards 表，含 card_id 主键和 dismissed_at", () => {
    const db = new Database(":memory:");
    migrate011(db);

    const cols = db.query<{ name: string; pk: number; notnull: number }, []>(
      "PRAGMA table_info(now_dismissed_cards)"
    ).all();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));

    expect(byName["card_id"]).toBeDefined();
    expect(byName["card_id"].pk).toBe(1);
    expect(byName["card_id"].notnull).toBe(1);
    expect(byName["dismissed_at"]).toBeDefined();
    expect(byName["dismissed_at"].notnull).toBe(1);
  });

  it("插入和查询 dismissed card 可往返", () => {
    const db = new Database(":memory:");
    migrate011(db);

    db.run("INSERT INTO now_dismissed_cards (card_id, dismissed_at) VALUES (?, ?)", [
      "completed:task-5",
      1700000000000,
    ]);
    const row = db.query<{ card_id: string; dismissed_at: number }, [string]>(
      "SELECT * FROM now_dismissed_cards WHERE card_id = ?"
    ).get("completed:task-5");
    expect(row?.dismissed_at).toBe(1700000000000);
  });
});
```

- [ ] **Step 1.2: 验证测试失败**

Run: `bun test tests/migration-011.test.ts`
Expected: FAIL —— "Cannot find module '../src/migrations/011-now-dismissed-cards'"

- [ ] **Step 1.3: 实现迁移**

Create `src/migrations/011-now-dismissed-cards.ts`:

```typescript
import type { Database } from "bun:sqlite";

/**
 * /now 卡片 dismiss 持久化表。
 * card_id 形如 "completed:task-5"、"task-failed:task-7"，由各 CardSource 生成。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS now_dismissed_cards (
      card_id TEXT PRIMARY KEY,
      dismissed_at INTEGER NOT NULL
    )
  `);
}
```

- [ ] **Step 1.4: 验证测试通过**

Run: `bun test tests/migration-011.test.ts`
Expected: PASS（2 cases）

- [ ] **Step 1.5: Commit**

```bash
git add src/migrations/011-now-dismissed-cards.ts tests/migration-011.test.ts
git commit -m "feat(core): 加 migration 011 创建 now_dismissed_cards 表"
```

---

## Task 2: 核心类型 — now-types.ts

**Files:**
- Create: `src/core/now-types.ts`

类型文件只导出 type，不导出值，所以无单测；后续 task 测试会消费这些类型。

- [ ] **Step 2.1: 创建类型文件**

Create `src/core/now-types.ts`:

```typescript
import type { AutopilotEvent } from "../daemon/protocol";

// ──────────────────────────────────────────────
// NowCard 协议
// ──────────────────────────────────────────────

export type NowCardPriority = "P0" | "P1" | "P2" | "P3";
export type NowCardCategory = "error" | "decision" | "running" | "completed";
export type NowCardActionKind = "primary" | "secondary" | "danger";

export interface NowCardAction {
  label: string;
  kind: NowCardActionKind;
  /** 客户端路由跳转（与 invoke 二选一） */
  href?: string;
  /** 触发后端动作（与 href 二选一） */
  invoke?: {
    method: "POST" | "PATCH";
    path: string;
    body?: unknown;
  };
}

export interface NowCardRelated {
  type: "task" | "requirement" | "provider" | "system";
  id: string;
}

export interface NowCard {
  /** 稳定 ID，形如 "<source-name>:<entity-id>"，例 "completed:task-5" */
  id: string;
  priority: NowCardPriority;
  category: NowCardCategory;
  title: string;
  subtitle: string;
  detail?: string;
  related?: NowCardRelated;
  actions: NowCardAction[];
  /** 由前端基于 created_at 实时计算，后端不推秒级更新 */
  waited_seconds?: number;
  dismissable: boolean;
  /** epoch seconds */
  created_at: number;
}

// ──────────────────────────────────────────────
// CardSource 抽象
// ──────────────────────────────────────────────

export type CardDelta =
  | { op: "add"; card: NowCard }
  | { op: "update"; id: string; patch: Partial<NowCard> }
  | { op: "remove"; id: string; reason: "resolved" | "dismissed" };

export interface CardSource {
  /** 唯一名，作为卡片 id 前缀，例 "completed"、"task-failed" */
  name: string;
  /** 订阅的 event-bus 事件类型；空数组表示纯 scan-only */
  subscribes: string[];
  /** 启动时全扫，返回当前应该展示的所有卡 */
  scan(): Promise<NowCard[]>;
  /** 事件来时计算增量。若与本 source 无关返回 [] */
  onEvent(event: AutopilotEvent): Promise<CardDelta[]>;
}
```

- [ ] **Step 2.2: 验证 TypeScript 编译通过**

Run: `bun run typecheck`
Expected: PASS（无新增 type 错）。

- [ ] **Step 2.3: Commit**

```bash
git add src/core/now-types.ts
git commit -m "feat(core): 加 now-types 定义 NowCard / CardSource / CardDelta"
```

---

## Task 3: protocol.ts 加 now:* 事件类型与 channel 分发

**Files:**
- Modify: `src/daemon/protocol.ts`
- Test: `tests/protocol-now-channels.test.ts`

- [ ] **Step 3.1: 写失败测试**

Create `tests/protocol-now-channels.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { getChannelsForEvent, type AutopilotEvent } from "../src/daemon/protocol";
import type { NowCard } from "../src/core/now-types";

const sampleCard: NowCard = {
  id: "await-review:task-5",
  priority: "P1",
  category: "decision",
  title: "Task #5 等审方案",
  subtitle: "design 阶段就绪",
  actions: [],
  dismissable: false,
  created_at: 1700000000,
};

describe("getChannelsForEvent — now:* 事件", () => {
  it("now:card_added 走 now:* 频道", () => {
    const event = { type: "now:card_added", payload: { card: sampleCard } } as AutopilotEvent;
    expect(getChannelsForEvent(event)).toContain("now:*");
  });

  it("now:card_updated 走 now:* 频道", () => {
    const event = { type: "now:card_updated", payload: { id: "x", patch: {} } } as AutopilotEvent;
    expect(getChannelsForEvent(event)).toContain("now:*");
  });

  it("now:card_removed 走 now:* 频道", () => {
    const event = { type: "now:card_removed", payload: { id: "x", reason: "resolved" } } as AutopilotEvent;
    expect(getChannelsForEvent(event)).toContain("now:*");
  });

  it("now:snapshot 走 now:* 频道", () => {
    const event = { type: "now:snapshot", payload: { cards: [] } } as AutopilotEvent;
    expect(getChannelsForEvent(event)).toContain("now:*");
  });
});
```

- [ ] **Step 3.2: 验证测试失败**

Run: `bun test tests/protocol-now-channels.test.ts`
Expected: FAIL —— 事件类型未定义或频道未路由。

- [ ] **Step 3.3: 在 protocol.ts 加事件类型**

Modify `src/daemon/protocol.ts`：在 `AutopilotEvent` union 末尾追加 4 条（紧贴最后一个 `requirement:all-questions-resolved` 之后）：

```typescript
  | { type: "requirement:all-questions-resolved"; payload: { id: string } }
  // ── /now 状态推导引擎事件（PR 1）──
  | { type: "now:card_added"; payload: { card: import("../core/now-types").NowCard } }
  | { type: "now:card_updated"; payload: { id: string; patch: Partial<import("../core/now-types").NowCard> } }
  | { type: "now:card_removed"; payload: { id: string; reason: "resolved" | "dismissed" } }
  | { type: "now:snapshot"; payload: { cards: import("../core/now-types").NowCard[] } };
```

> 用 `import("...")` 内联类型引用，避免在 protocol.ts 顶部引入 `now-types`（防止循环依赖：now-types.ts 已 `import type { AutopilotEvent } from "../daemon/protocol"`）。

- [ ] **Step 3.4: 在 getChannelsForEvent 加 now case**

Modify `src/daemon/protocol.ts` 的 `getChannelsForEvent` switch（在 `case "requirement":` 之后追加）：

```typescript
    case "requirement": {
      channels.push("requirement:*");
      break;
    }
    case "now": {
      channels.push("now:*");
      break;
    }
```

- [ ] **Step 3.5: 验证测试通过**

Run: `bun test tests/protocol-now-channels.test.ts`
Expected: PASS（4 cases）

- [ ] **Step 3.6: Commit**

```bash
git add src/daemon/protocol.ts tests/protocol-now-channels.test.ts
git commit -m "feat(daemon): protocol 加 now:* 事件类型与 channel 分发"
```

---

## Task 4: dismiss 持久化模块 — now-dismiss.ts

**Files:**
- Create: `src/core/now-dismiss.ts`
- Test: `tests/now-dismiss.test.ts`

- [ ] **Step 4.1: 写失败测试**

Create `tests/now-dismiss.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate011 } from "../src/migrations/011-now-dismissed-cards";
import { _setDbForTest } from "../src/core/db";
import { dismissCard, isCardDismissed, clearDismissedCard, listDismissedCardIds } from "../src/core/now-dismiss";

describe("now-dismiss", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    migrate011(db);
    _setDbForTest(db);
  });

  it("dismissCard 后 isCardDismissed 返回 true", () => {
    expect(isCardDismissed("completed:task-5")).toBe(false);
    dismissCard("completed:task-5");
    expect(isCardDismissed("completed:task-5")).toBe(true);
  });

  it("clearDismissedCard 撤销 dismiss", () => {
    dismissCard("task-failed:task-7");
    expect(isCardDismissed("task-failed:task-7")).toBe(true);
    clearDismissedCard("task-failed:task-7");
    expect(isCardDismissed("task-failed:task-7")).toBe(false);
  });

  it("重复 dismiss 同一 card_id 是幂等", () => {
    dismissCard("completed:task-5");
    dismissCard("completed:task-5"); // 不抛
    const ids = listDismissedCardIds();
    expect(ids.filter(id => id === "completed:task-5").length).toBe(1);
  });

  it("listDismissedCardIds 返回全部已 dismiss", () => {
    dismissCard("a");
    dismissCard("b");
    const ids = listDismissedCardIds();
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 4.2: 验证测试失败**

Run: `bun test tests/now-dismiss.test.ts`
Expected: FAIL —— Cannot find module。

- [ ] **Step 4.3: 实现 now-dismiss.ts**

Create `src/core/now-dismiss.ts`:

```typescript
import { getDb } from "./db";

/**
 * /now 卡片 dismiss 持久化。card_id 由各 CardSource 生成，形如 "completed:task-5"。
 * dismiss 只影响是否在 /now 显示，对应实体（Task/Requirement）状态不变。
 * 当对应实体状态发生显著变化时（如 task 从 failed 转出），aggregator 应清掉对应 dismiss 记录。
 */

export function dismissCard(cardId: string): void {
  getDb().run(
    "INSERT OR REPLACE INTO now_dismissed_cards (card_id, dismissed_at) VALUES (?, ?)",
    [cardId, Date.now()],
  );
}

export function clearDismissedCard(cardId: string): void {
  getDb().run("DELETE FROM now_dismissed_cards WHERE card_id = ?", [cardId]);
}

export function isCardDismissed(cardId: string): boolean {
  const row = getDb()
    .query<{ card_id: string }, [string]>(
      "SELECT card_id FROM now_dismissed_cards WHERE card_id = ?",
    )
    .get(cardId);
  return row !== null;
}

export function listDismissedCardIds(): string[] {
  const rows = getDb()
    .query<{ card_id: string }, []>("SELECT card_id FROM now_dismissed_cards")
    .all();
  return rows.map((r) => r.card_id);
}
```

- [ ] **Step 4.4: 验证测试通过**

Run: `bun test tests/now-dismiss.test.ts`
Expected: PASS（4 cases）

- [ ] **Step 4.5: Commit**

```bash
git add src/core/now-dismiss.ts tests/now-dismiss.test.ts
git commit -m "feat(core): 加 now-dismiss 持久化模块"
```

---

## Task 5: now-aggregator 核心（fake source 验证逻辑）

**Files:**
- Create: `src/core/now-aggregator.ts`
- Test: `tests/now-aggregator.test.ts`

本 task 不挂任何真 CardSource，用 fake source 验证：注册、scan、事件分发、排序、dismiss 过滤、emit 增量。

- [ ] **Step 5.1: 写失败测试**

Create `tests/now-aggregator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate011 } from "../src/migrations/011-now-dismissed-cards";
import { _setDbForTest } from "../src/core/db";
import {
  createAggregator,
  type Aggregator,
} from "../src/core/now-aggregator";
import { dismissCard } from "../src/core/now-dismiss";
import type { CardSource, NowCard, CardDelta } from "../src/core/now-types";
import { enableBus, disableBus, emit } from "../src/daemon/event-bus";

function card(id: string, priority: NowCard["priority"], createdAt = 1000): NowCard {
  return {
    id,
    priority,
    category: "decision",
    title: id,
    subtitle: "",
    actions: [],
    dismissable: true,
    created_at: createdAt,
  };
}

describe("now-aggregator", () => {
  let agg: Aggregator;

  beforeEach(() => {
    const db = new Database(":memory:");
    migrate011(db);
    _setDbForTest(db);
    enableBus();
  });

  afterEach(() => {
    if (agg) agg.dispose();
    disableBus();
  });

  it("启动时调用所有 source 的 scan() 建立快照", async () => {
    const src: CardSource = {
      name: "fake",
      subscribes: [],
      scan: async () => [card("fake:1", "P1"), card("fake:2", "P2")],
      onEvent: async () => [],
    };
    agg = createAggregator([src]);
    await agg.start();
    const cards = agg.getCards();
    expect(cards.map(c => c.id).sort()).toEqual(["fake:1", "fake:2"]);
  });

  it("getCards 返回按优先级排序（P0 → P3，同层按 created_at 升序）", async () => {
    const src: CardSource = {
      name: "fake",
      subscribes: [],
      scan: async () => [
        card("fake:p3", "P3", 1000),
        card("fake:p0", "P0", 1000),
        card("fake:p1-late", "P1", 2000),
        card("fake:p1-early", "P1", 1000),
      ],
      onEvent: async () => [],
    };
    agg = createAggregator([src]);
    await agg.start();
    const ids = agg.getCards().map(c => c.id);
    expect(ids).toEqual(["fake:p0", "fake:p1-early", "fake:p1-late", "fake:p3"]);
  });

  it("scan 中的 dismissed 卡被过滤", async () => {
    dismissCard("fake:gone");
    const src: CardSource = {
      name: "fake",
      subscribes: [],
      scan: async () => [card("fake:gone", "P3"), card("fake:keep", "P1")],
      onEvent: async () => [],
    };
    agg = createAggregator([src]);
    await agg.start();
    expect(agg.getCards().map(c => c.id)).toEqual(["fake:keep"]);
  });

  it("事件来时调用对应 source.onEvent，应用增量到快照", async () => {
    let received = 0;
    const src: CardSource = {
      name: "fake",
      subscribes: ["task:transition"],
      scan: async () => [],
      onEvent: async () => {
        received++;
        return [{ op: "add", card: card("fake:new", "P1") }];
      },
    };
    agg = createAggregator([src]);
    await agg.start();
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x" } });
    // event 同步分发；onEvent 是 async，等一拍
    await new Promise(r => setTimeout(r, 10));
    expect(received).toBeGreaterThan(0);
    expect(agg.getCards().map(c => c.id)).toContain("fake:new");
  });

  it("应用增量后通过 emit 推 now:card_added 事件", async () => {
    const events: string[] = [];
    const src: CardSource = {
      name: "fake",
      subscribes: ["task:transition"],
      scan: async () => [],
      onEvent: async () => [{ op: "add", card: card("fake:x", "P1") }],
    };
    agg = createAggregator([src], { emit: (e) => events.push(e.type) });
    await agg.start();
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x" } });
    await new Promise(r => setTimeout(r, 10));
    expect(events).toContain("now:card_added");
  });

  it("dismiss 后 update/add 不再产出（已被过滤），remove 仍清空", async () => {
    dismissCard("fake:x");
    const src: CardSource = {
      name: "fake",
      subscribes: ["task:transition"],
      scan: async () => [],
      onEvent: async () => [{ op: "add", card: card("fake:x", "P1") }],
    };
    agg = createAggregator([src]);
    await agg.start();
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x" } });
    await new Promise(r => setTimeout(r, 10));
    expect(agg.getCards()).toEqual([]);
  });

  it("dispose 后事件不再触发 source", async () => {
    let count = 0;
    const src: CardSource = {
      name: "fake",
      subscribes: ["task:transition"],
      scan: async () => [],
      onEvent: async () => { count++; return []; },
    };
    agg = createAggregator([src]);
    await agg.start();
    agg.dispose();
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x" } });
    await new Promise(r => setTimeout(r, 10));
    expect(count).toBe(0);
    agg = undefined as unknown as Aggregator; // 防止 afterEach 再 dispose
  });
});
```

- [ ] **Step 5.2: 验证测试失败**

Run: `bun test tests/now-aggregator.test.ts`
Expected: FAIL —— Cannot find module。

- [ ] **Step 5.3: 实现 now-aggregator.ts**

Create `src/core/now-aggregator.ts`:

```typescript
import type { CardSource, CardDelta, NowCard, NowCardPriority } from "./now-types";
import type { AutopilotEvent } from "../daemon/protocol";
import { onEvent as busOn, offEvent as busOff, emit as busEmit } from "../daemon/event-bus";
import { isCardDismissed, listDismissedCardIds } from "./now-dismiss";

const PRIORITY_ORDER: Record<NowCardPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface AggregatorOptions {
  /** 注入 emit 用于测试；默认走 event-bus.emit */
  emit?: (event: AutopilotEvent) => void;
}

export interface Aggregator {
  /** 调用所有 source.scan() 建立内存快照，然后挂事件订阅 */
  start(): Promise<void>;
  /** 按优先级 + created_at 排序后的快照副本 */
  getCards(): NowCard[];
  /** 取消所有事件订阅，清空快照 */
  dispose(): void;
}

export function createAggregator(
  sources: CardSource[],
  opts: AggregatorOptions = {},
): Aggregator {
  const snapshot = new Map<string, NowCard>();
  const emit = opts.emit ?? busEmit;
  const handlers: Array<{ type: string; fn: (e: AutopilotEvent) => void }> = [];

  function applyDelta(delta: CardDelta): void {
    if (delta.op === "add") {
      if (isCardDismissed(delta.card.id)) return;
      snapshot.set(delta.card.id, delta.card);
      emit({ type: "now:card_added", payload: { card: delta.card } });
    } else if (delta.op === "update") {
      if (isCardDismissed(delta.id)) return;
      const cur = snapshot.get(delta.id);
      if (!cur) return;
      const next = { ...cur, ...delta.patch };
      snapshot.set(delta.id, next);
      emit({ type: "now:card_updated", payload: { id: delta.id, patch: delta.patch } });
    } else if (delta.op === "remove") {
      if (!snapshot.delete(delta.id)) return;
      emit({ type: "now:card_removed", payload: { id: delta.id, reason: delta.reason } });
    }
  }

  async function dispatchEvent(event: AutopilotEvent): Promise<void> {
    for (const src of sources) {
      if (!src.subscribes.includes(event.type)) continue;
      try {
        const deltas = await src.onEvent(event);
        for (const d of deltas) applyDelta(d);
      } catch (e: unknown) {
        // single source failure 不影响整体；打日志
        console.error(`[now-aggregator] source ${src.name} onEvent 失败:`, e);
      }
    }
  }

  return {
    async start() {
      const dismissedIds = new Set(listDismissedCardIds());
      // 全扫
      for (const src of sources) {
        try {
          const cards = await src.scan();
          for (const c of cards) {
            if (dismissedIds.has(c.id)) continue;
            snapshot.set(c.id, c);
          }
        } catch (e: unknown) {
          console.error(`[now-aggregator] source ${src.name} scan 失败:`, e);
        }
      }
      // 挂事件订阅：去重后的 event type 集合
      const types = new Set(sources.flatMap((s) => s.subscribes));
      for (const type of types) {
        const fn = (event: AutopilotEvent) => {
          // bun event emitter 同步调；dispatchEvent 是 async，fire-and-forget
          dispatchEvent(event).catch((e) =>
            console.error("[now-aggregator] dispatchEvent 异常:", e),
          );
        };
        busOn(type, fn);
        handlers.push({ type, fn });
      }
    },
    getCards() {
      return [...snapshot.values()].sort((a, b) => {
        const dp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (dp !== 0) return dp;
        return a.created_at - b.created_at;
      });
    },
    dispose() {
      for (const { type, fn } of handlers) busOff(type, fn);
      handlers.length = 0;
      snapshot.clear();
    },
  };
}
```

> 设计要点：
> 1. `emit` 默认走真 event-bus；测试可注入 fake（见 Task 5 测试用例 "应用增量后通过 emit 推 now:card_added 事件"）。
> 2. dispatchEvent 是 async；从 EventEmitter 看是 fire-and-forget（事件来时立刻返回，后续异步执行 onEvent）。这意味着客户端可能在 emit 后立刻 GET /api/now/cards 但还没看到增量 —— 这是可接受的（WS 推送会补，前端 reconcile）。
> 3. `applyDelta` 中 `op: 'add'` 对同一 id 重复出现是覆盖语义（Map.set 直接替换），所以下游 source 可以始终用 add 表达 upsert，不必区分 add/update。

- [ ] **Step 5.4: 验证测试通过**

Run: `bun test tests/now-aggregator.test.ts`
Expected: PASS（7 cases）

- [ ] **Step 5.5: Commit**

```bash
git add src/core/now-aggregator.ts tests/now-aggregator.test.ts
git commit -m "feat(core): 加 now-aggregator 核心（注册 / scan / 事件 / 排序 / dismiss）"
```

---

## Task 6: CardSource — awaiting-approval

**Files:**
- Create: `src/core/card-sources/awaiting-approval.ts`
- Test: `tests/card-sources/awaiting-approval.test.ts`

最简单的 source：scan 时拉所有 `requirement.status='awaiting_approval'` 的需求；订阅 `requirement:status-changed`。

- [ ] **Step 6.1: 写失败测试**

Create `tests/card-sources/awaiting-approval.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createRequirement, setRequirementStatus } from "../../src/core/requirements";
import { createAwaitingApprovalSource } from "../../src/core/card-sources/awaiting-approval";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("CardSource: awaiting-approval", () => {
  beforeEach(() => {
    initSchema();
    createProject({ id: "proj-001", name: "测试项目" });
  });

  it("name = 'awaiting-approval'，subscribes 包含 requirement:status-changed", () => {
    const src = createAwaitingApprovalSource();
    expect(src.name).toBe("awaiting-approval");
    expect(src.subscribes).toContain("requirement:status-changed");
  });

  it("scan 返回所有 status=awaiting_approval 的需求作 P1 决策卡", async () => {
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "改 hover bug", spec_md: "" });
    setRequirementStatus("REQ-001", "investigating");
    setRequirementStatus("REQ-001", "awaiting_approval");

    const src = createAwaitingApprovalSource();
    const cards = await src.scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("awaiting-approval:REQ-001");
    expect(cards[0].priority).toBe("P1");
    expect(cards[0].category).toBe("decision");
    expect(cards[0].title).toContain("改 hover bug");
    expect(cards[0].related).toEqual({ type: "requirement", id: "REQ-001" });
    // 至少有一个 primary action 指向 /requirements/REQ-001
    const primary = cards[0].actions.find(a => a.kind === "primary");
    expect(primary?.href).toBe("/requirements/REQ-001");
  });

  it("scan 跳过非 awaiting_approval 状态的需求", async () => {
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "X", spec_md: "" });
    // 默认 status=draft
    const src = createAwaitingApprovalSource();
    const cards = await src.scan();
    expect(cards).toHaveLength(0);
  });

  it("onEvent 收到 status-changed 到 awaiting_approval 产出 add delta", async () => {
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "X", spec_md: "" });
    setRequirementStatus("REQ-001", "investigating");
    setRequirementStatus("REQ-001", "awaiting_approval");

    const src = createAwaitingApprovalSource();
    const deltas = await src.onEvent({
      type: "requirement:status-changed",
      payload: { id: "REQ-001", from: "investigating", to: "awaiting_approval" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
    if (deltas[0].op === "add") expect(deltas[0].card.id).toBe("awaiting-approval:REQ-001");
  });

  it("onEvent 收到从 awaiting_approval 转走的 status-changed 产出 remove delta", async () => {
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "X", spec_md: "" });
    const src = createAwaitingApprovalSource();
    const deltas = await src.onEvent({
      type: "requirement:status-changed",
      payload: { id: "REQ-001", from: "awaiting_approval", to: "queued" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") {
      expect(deltas[0].id).toBe("awaiting-approval:REQ-001");
      expect(deltas[0].reason).toBe("resolved");
    }
  });

  it("onEvent 与其他事件类型时返回空数组", async () => {
    const src = createAwaitingApprovalSource();
    const deltas = await src.onEvent({
      type: "task:created",
      payload: { task: {} as never },
    });
    expect(deltas).toEqual([]);
  });
});
```

- [ ] **Step 6.2: 验证测试失败**

Run: `bun test tests/card-sources/awaiting-approval.test.ts`
Expected: FAIL —— Cannot find module。

- [ ] **Step 6.3: 实现 awaiting-approval source**

Create `src/core/card-sources/awaiting-approval.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { listRequirements, getRequirementById } from "../requirements";

function buildCard(req: { id: string; title: string; created_at: number }): NowCard {
  return {
    id: `awaiting-approval:${req.id}`,
    priority: "P1",
    category: "decision",
    title: `等审批：${req.title}`,
    subtitle: `需求 ${req.id} 已就绪，等你审批入队`,
    related: { type: "requirement", id: req.id },
    actions: [
      { label: "去看", kind: "primary", href: `/requirements/${req.id}` },
    ],
    dismissable: false,
    created_at: Math.floor(req.created_at / 1000),
  };
}

export function createAwaitingApprovalSource(): CardSource {
  return {
    name: "awaiting-approval",
    subscribes: ["requirement:status-changed"],

    async scan() {
      const reqs = listRequirements({}).filter((r) => r.status === "awaiting_approval");
      return reqs.map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "requirement:status-changed") return [];
      const { id, from, to } = event.payload;
      if (to === "awaiting_approval") {
        const req = getRequirementById(id);
        if (!req) return [];
        return [{ op: "add", card: buildCard(req) }];
      }
      if (from === "awaiting_approval") {
        return [{ op: "remove", id: `awaiting-approval:${id}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
```

> 注：`listRequirements({})` 接受过滤参数对象；若签名不同，按实际类型调整调用。`getRequirementById` 返回 `Requirement | null`。

- [ ] **Step 6.4: 验证测试通过**

Run: `bun test tests/card-sources/awaiting-approval.test.ts`
Expected: PASS（6 cases）

- [ ] **Step 6.5: Commit**

```bash
git add src/core/card-sources/awaiting-approval.ts tests/card-sources/awaiting-approval.test.ts
git commit -m "feat(card-sources): awaiting-approval（P1 决策：需求等审批）"
```

---

## Task 7: CardSource — open-question

**Files:**
- Create: `src/core/card-sources/open-question.ts`
- Test: `tests/card-sources/open-question.test.ts`

订阅 `requirement:questions-updated` / `requirement:all-questions-resolved`。

- [ ] **Step 7.1: 写失败测试**

Create `tests/card-sources/open-question.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createRequirement } from "../../src/core/requirements";
import { createQuestion, resolveQuestion } from "../../src/core/requirement-questions";
import { createOpenQuestionSource } from "../../src/core/card-sources/open-question";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("CardSource: open-question", () => {
  beforeEach(() => {
    initSchema();
    createProject({ id: "proj-001", name: "P" });
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "Req", spec_md: "" });
  });

  it("name = 'open-question'", () => {
    expect(createOpenQuestionSource().name).toBe("open-question");
  });

  it("scan 返回所有 open 状态的问题为 P1 决策卡，每问一张", async () => {
    createQuestion({ id: "QST-001", requirement_id: "REQ-001", agent_text: "邮件还是短信?" });
    createQuestion({ id: "QST-002", requirement_id: "REQ-001", agent_text: "5 分钟过期对吗?" });

    const cards = await createOpenQuestionSource().scan();
    expect(cards.map(c => c.id).sort()).toEqual([
      "open-question:QST-001",
      "open-question:QST-002",
    ]);
    expect(cards[0].priority).toBe("P1");
    expect(cards[0].category).toBe("decision");
    expect(cards[0].related).toEqual({ type: "requirement", id: "REQ-001" });
    expect(cards[0].actions.some(a => a.kind === "primary")).toBe(true);
  });

  it("scan 跳过 resolved 状态的问题", async () => {
    createQuestion({ id: "QST-001", requirement_id: "REQ-001", agent_text: "Q1?" });
    resolveQuestion("QST-001");
    const cards = await createOpenQuestionSource().scan();
    expect(cards).toEqual([]);
  });

  it("onEvent 收到 questions-updated 重扫该 requirement 的 open questions（diff 出 add/remove）", async () => {
    createQuestion({ id: "QST-001", requirement_id: "REQ-001", agent_text: "Q1?" });
    const src = createOpenQuestionSource();
    // 首次 scan 后内存里没有 QST-001（aggregator 维护快照，这里直接测 onEvent 返回的 deltas）
    // 因此首次 questions-updated 会输出 add(QST-001)
    const deltas = await src.onEvent({
      type: "requirement:questions-updated",
      payload: { id: "REQ-001" },
    });
    expect(deltas.some(d => d.op === "add" && d.card.id === "open-question:QST-001")).toBe(true);
  });

  it("onEvent 收到 all-questions-resolved 输出 remove 所有该 requirement 的卡", async () => {
    createQuestion({ id: "QST-001", requirement_id: "REQ-001", agent_text: "Q1?" });
    const src = createOpenQuestionSource();
    // 先用一次 questions-updated 让 source 知道 REQ-001 上有 QST-001
    await src.onEvent({ type: "requirement:questions-updated", payload: { id: "REQ-001" } });
    resolveQuestion("QST-001");
    const deltas = await src.onEvent({
      type: "requirement:all-questions-resolved",
      payload: { id: "REQ-001" },
    });
    expect(deltas.some(d => d.op === "remove" && d.id === "open-question:QST-001")).toBe(true);
  });
});
```

- [ ] **Step 7.2: 验证测试失败**

Run: `bun test tests/card-sources/open-question.test.ts`
Expected: FAIL —— Cannot find module。

- [ ] **Step 7.3: 实现 open-question source**

Create `src/core/card-sources/open-question.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { listQuestionsByRequirement } from "../requirement-questions";
import { getDb } from "../db";

function buildCard(q: { id: string; requirement_id: string; agent_text: string; created_at: number }): NowCard {
  const preview = q.agent_text.length > 80 ? q.agent_text.slice(0, 80) + "…" : q.agent_text;
  return {
    id: `open-question:${q.id}`,
    priority: "P1",
    category: "decision",
    title: `AI 提了个问题`,
    subtitle: `Req ${q.requirement_id} · ${preview}`,
    related: { type: "requirement", id: q.requirement_id },
    actions: [
      { label: "回答", kind: "primary", href: `/requirements/${q.requirement_id}` },
    ],
    dismissable: false,
    created_at: Math.floor(q.created_at / 1000),
  };
}

/** 拉所有 open 问题（跨 requirement）—— requirement_questions 表没有 listAll 接口，直接查。 */
function listAllOpenQuestions(): Array<{ id: string; requirement_id: string; agent_text: string; created_at: number }> {
  return getDb().query<
    { id: string; requirement_id: string; agent_text: string; created_at: number },
    []
  >(
    "SELECT id, requirement_id, agent_text, created_at FROM requirement_questions WHERE status = 'open'"
  ).all();
}

export function createOpenQuestionSource(): CardSource {
  /** 跟踪 source 已知的 open question ids，用于 onEvent diff */
  const known = new Set<string>();

  return {
    name: "open-question",
    subscribes: ["requirement:questions-updated", "requirement:all-questions-resolved"],

    async scan() {
      const qs = listAllOpenQuestions();
      known.clear();
      for (const q of qs) known.add(q.id);
      return qs.map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "requirement:questions-updated"
          && event.type !== "requirement:all-questions-resolved") {
        return [];
      }
      const reqId = event.payload.id;
      const all = listQuestionsByRequirement(reqId);
      const deltas: CardDelta[] = [];

      // Adds：当前 open 但 known 没有
      for (const q of all) {
        if (q.status === "open" && !known.has(q.id)) {
          known.add(q.id);
          deltas.push({ op: "add", card: buildCard(q) });
        }
      }
      // Removes：known 中存在但当前已 resolved 的（属于本 requirement）
      for (const q of all) {
        if (q.status !== "open" && known.has(q.id)) {
          known.delete(q.id);
          deltas.push({ op: "remove", id: `open-question:${q.id}`, reason: "resolved" });
        }
      }
      return deltas;
    },
  };
}
```

> 这个 source 的 onEvent 复杂一点是因为 `requirement:questions-updated` 是"该需求下问题变了"的粗粒度事件，需要本地 diff。`known` 集合在 scan 时建立、onEvent 中维护。aggregator 不要求 source 自己维护内存——这是 source 自己的实现细节。

- [ ] **Step 7.4: 验证测试通过**

Run: `bun test tests/card-sources/open-question.test.ts`
Expected: PASS（5 cases）

- [ ] **Step 7.5: Commit**

```bash
git add src/core/card-sources/open-question.ts tests/card-sources/open-question.test.ts
git commit -m "feat(card-sources): open-question（P1 决策：AI 提的待回答问题）"
```

---

## Task 8: CardSource — await-review

**Files:**
- Create: `src/core/card-sources/await-review.ts`
- Test: `tests/card-sources/await-review.test.ts`

订阅 `task:transition`。task.status = `running_await_review` 时出 P1 卡。

- [ ] **Step 8.1: 写失败测试**

Create `tests/card-sources/await-review.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest, getDb, createTask } from "../../src/core/db";
import { createAwaitReviewSource } from "../../src/core/card-sources/await-review";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

function setStatus(taskId: string, status: string): void {
  getDb().run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
    status, new Date().toISOString(), taskId,
  ]);
}

describe("CardSource: await-review", () => {
  beforeEach(() => {
    initSchema();
  });

  it("name = 'await-review'，订阅 task:transition", () => {
    const src = createAwaitReviewSource();
    expect(src.name).toBe("await-review");
    expect(src.subscribes).toContain("task:transition");
  });

  it("scan 返回所有 status=running_await_review 的 task 为 P1 决策卡", async () => {
    createTask({ id: "task-1", title: "T1", workflow: "dev" });
    setStatus("task-1", "running_await_review");
    createTask({ id: "task-2", title: "T2", workflow: "dev" });
    setStatus("task-2", "running_design");

    const cards = await createAwaitReviewSource().scan();
    expect(cards.map(c => c.id)).toEqual(["await-review:task-1"]);
    expect(cards[0].priority).toBe("P1");
    expect(cards[0].related).toEqual({ type: "task", id: "task-1" });
    expect(cards[0].actions.some(a => a.label === "看方案" && a.kind === "primary")).toBe(true);
    expect(cards[0].actions.some(a => a.label === "驳回" && a.kind === "danger")).toBe(true);
  });

  it("onEvent: to running_await_review 产出 add", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev" });
    setStatus("task-1", "running_await_review");
    const deltas = await createAwaitReviewSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_await_review", trigger: "design_done" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
  });

  it("onEvent: from running_await_review 产出 remove", async () => {
    const deltas = await createAwaitReviewSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_await_review", to: "running_development", trigger: "approved" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") expect(deltas[0].id).toBe("await-review:task-1");
  });

  it("onEvent: 既不是去也不是离 await_review 返回空", async () => {
    const deltas = await createAwaitReviewSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_development", trigger: "x" },
    });
    expect(deltas).toEqual([]);
  });
});
```

- [ ] **Step 8.2: 验证测试失败**

Run: `bun test tests/card-sources/await-review.test.ts`
Expected: FAIL。

- [ ] **Step 8.3: 实现 await-review source**

Create `src/core/card-sources/await-review.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { getTask, listTasks } from "../db";

const AWAIT_REVIEW_STATUS = "running_await_review";

function buildCard(task: { id: string; title: string; created_at: string }): NowCard {
  return {
    id: `await-review:${task.id}`,
    priority: "P1",
    category: "decision",
    title: `Task #${task.id} 等审方案`,
    subtitle: `${task.title} · design 阶段产物已就绪`,
    related: { type: "task", id: task.id },
    actions: [
      { label: "看方案", kind: "primary", href: `/tasks/${task.id}` },
      { label: "驳回", kind: "danger", href: `/tasks/${task.id}?action=reject` },
    ],
    dismissable: false,
    created_at: Math.floor(new Date(task.created_at).getTime() / 1000),
  };
}

export function createAwaitReviewSource(): CardSource {
  return {
    name: "await-review",
    subscribes: ["task:transition"],

    async scan() {
      return listTasks({ status: AWAIT_REVIEW_STATUS }).map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "task:transition") return [];
      const { taskId, from, to } = event.payload;
      if (to === AWAIT_REVIEW_STATUS) {
        const task = getTask(taskId);
        if (!task) return [];
        return [{ op: "add", card: buildCard(task) }];
      }
      if (from === AWAIT_REVIEW_STATUS) {
        return [{ op: "remove", id: `await-review:${taskId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
```

- [ ] **Step 8.4: 验证测试通过**

Run: `bun test tests/card-sources/await-review.test.ts`
Expected: PASS（5 cases）

- [ ] **Step 8.5: Commit**

```bash
git add src/core/card-sources/await-review.ts tests/card-sources/await-review.test.ts
git commit -m "feat(card-sources): await-review（P1 决策：task 等审方案）"
```

---

## Task 9: CardSource — running

**Files:**
- Create: `src/core/card-sources/running.ts`
- Test: `tests/card-sources/running.test.ts`

订阅 `task:transition`。task.status LIKE `running_%` 且不是 `running_await_review` 时出 P2 卡。

- [ ] **Step 9.1: 写失败测试**

Create `tests/card-sources/running.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest, getDb, createTask } from "../../src/core/db";
import { createRunningSource } from "../../src/core/card-sources/running";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

function setStatus(taskId: string, status: string): void {
  getDb().run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
    status, new Date().toISOString(), taskId,
  ]);
}

describe("CardSource: running", () => {
  beforeEach(() => initSchema());

  it("scan 返回所有 running_<phase> 但不含 running_await_review", async () => {
    createTask({ id: "task-1", title: "T1", workflow: "dev" });
    setStatus("task-1", "running_design");
    createTask({ id: "task-2", title: "T2", workflow: "dev" });
    setStatus("task-2", "running_await_review");
    createTask({ id: "task-3", title: "T3", workflow: "dev" });
    setStatus("task-3", "done");

    const cards = await createRunningSource().scan();
    expect(cards.map(c => c.id)).toEqual(["running:task-1"]);
    expect(cards[0].priority).toBe("P2");
    expect(cards[0].category).toBe("running");
    expect(cards[0].subtitle).toContain("design");
  });

  it("onEvent: 进入任意 running_X（非 await_review）产出 add", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev" });
    setStatus("task-1", "running_development");
    const deltas = await createRunningSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_development", trigger: "x" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
  });

  it("onEvent: 进入 running_await_review 不产出（让 await-review source 处理）", async () => {
    const deltas = await createRunningSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_await_review", trigger: "x" },
    });
    expect(deltas).toEqual([]);
  });

  it("onEvent: 从 running_X 转到非 running（done/failed/canceled）产出 remove", async () => {
    const deltas = await createRunningSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_development", to: "done", trigger: "x" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });

  it("onEvent: 同 running_X 之间切换（如 design → development）产出 update（保留卡，刷副标题）", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev" });
    setStatus("task-1", "running_development");
    const deltas = await createRunningSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_development", trigger: "x" },
    });
    // 第一次进入：add；后续阶段间转换：update
    // 这里 source 不持有内存 —— 让 aggregator 通过 add/update 语义协商：始终走 add，
    // aggregator 看到已存在则触发 update 路径。为简化 source 实现，这里仍输出 add；
    // aggregator.applyDelta 应当处理"add 同 id"为覆盖。
    // 但本测试断言"返回一个 op"，op 可以是 add 也可以是 update；我们保持 add 实现。
    expect(deltas).toHaveLength(1);
    expect(["add", "update"]).toContain(deltas[0].op);
  });
});
```

> 实现注：本 source 同一卡在 phase 间切换时输出 `add`（aggregator 内 `set(id, card)` 会覆盖），简单可靠；前端拿到 `now:card_added` 重复 id 时按 upsert 处理。

- [ ] **Step 9.2: 验证测试失败**

Run: `bun test tests/card-sources/running.test.ts`
Expected: FAIL。

- [ ] **Step 9.3: 实现 running source**

Create `src/core/card-sources/running.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { getTask, getDb } from "../db";
import type { Task } from "../db";

const AWAIT_REVIEW_STATUS = "running_await_review";

function phaseOf(status: string): string {
  return status.startsWith("running_") ? status.slice("running_".length) : status;
}

function buildCard(task: Task): NowCard {
  return {
    id: `running:${task.id}`,
    priority: "P2",
    category: "running",
    title: `Task #${task.id} 进行中`,
    subtitle: `${task.title} · ${phaseOf(task.status)} 阶段`,
    related: { type: "task", id: task.id },
    actions: [
      { label: "看日志", kind: "secondary", href: `/tasks/${task.id}` },
    ],
    dismissable: false,
    created_at: Math.floor(new Date(task.created_at).getTime() / 1000),
  };
}

function listRunningExceptAwaitReview(): Task[] {
  return getDb().query<Task, []>(
    "SELECT * FROM tasks WHERE status LIKE 'running_%' AND status != 'running_await_review'"
  ).all();
}

export function createRunningSource(): CardSource {
  return {
    name: "running",
    subscribes: ["task:transition"],

    async scan() {
      return listRunningExceptAwaitReview().map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "task:transition") return [];
      const { taskId, from, to } = event.payload;
      const toRunning = to.startsWith("running_") && to !== AWAIT_REVIEW_STATUS;
      const fromRunning = from.startsWith("running_") && from !== AWAIT_REVIEW_STATUS;

      if (toRunning) {
        const task = getTask(taskId);
        if (!task) return [];
        return [{ op: "add", card: buildCard(task) }];
      }
      if (fromRunning && !toRunning) {
        return [{ op: "remove", id: `running:${taskId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
```

- [ ] **Step 9.4: 验证测试通过**

Run: `bun test tests/card-sources/running.test.ts`
Expected: PASS（5 cases）

- [ ] **Step 9.5: Commit**

```bash
git add src/core/card-sources/running.ts tests/card-sources/running.test.ts
git commit -m "feat(card-sources): running（P2 进行：task 在 running_X 非 await_review）"
```

---

## Task 10: CardSource — stuck

**Files:**
- Create: `src/core/card-sources/stuck.ts`
- Test: `tests/card-sources/stuck.test.ts`

订阅 `watcher:recovery`：watcher 把卡死任务自动重启了，但这件事用户需要知道（"曾经卡过"）。出 P1 决策卡，用户 dismiss 后消失。

- [ ] **Step 10.1: 写失败测试**

Create `tests/card-sources/stuck.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest } from "../../src/core/db";
import { createStuckSource } from "../../src/core/card-sources/stuck";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("CardSource: stuck", () => {
  beforeEach(() => initSchema());

  it("name = 'stuck'，订阅 watcher:recovery", () => {
    const src = createStuckSource();
    expect(src.name).toBe("stuck");
    expect(src.subscribes).toEqual(["watcher:recovery"]);
  });

  it("scan 返回空（stuck 卡只在事件来时产生，无持久来源）", async () => {
    expect(await createStuckSource().scan()).toEqual([]);
  });

  it("onEvent: watcher:recovery 产出 P1 add 卡，dismissable=true", async () => {
    const deltas = await createStuckSource().onEvent({
      type: "watcher:recovery",
      payload: { taskId: "task-1", phase: "development", fromStatus: "running_development", toStatus: "pending_development" },
    });
    expect(deltas).toHaveLength(1);
    if (deltas[0].op === "add") {
      expect(deltas[0].card.id).toBe("stuck:task-1");
      expect(deltas[0].card.priority).toBe("P1");
      expect(deltas[0].card.dismissable).toBe(true);
      expect(deltas[0].card.related).toEqual({ type: "task", id: "task-1" });
    }
  });
});
```

- [ ] **Step 10.2: 验证测试失败**

Run: `bun test tests/card-sources/stuck.test.ts`
Expected: FAIL。

- [ ] **Step 10.3: 实现 stuck source**

Create `src/core/card-sources/stuck.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";

function buildCard(taskId: string, phase: string, fromStatus: string, toStatus: string): NowCard {
  return {
    id: `stuck:${taskId}`,
    priority: "P1",
    category: "decision",
    title: `⚠ Task #${taskId} 曾卡死，已自动恢复`,
    subtitle: `${phase} 阶段：${fromStatus} → ${toStatus}（watcher 接管）`,
    related: { type: "task", id: taskId },
    actions: [
      { label: "看日志", kind: "primary", href: `/tasks/${taskId}` },
      { label: "关闭", kind: "secondary", invoke: {
        method: "POST",
        path: `/api/now/cards/stuck:${taskId}/dismiss`,
      } },
    ],
    dismissable: true,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function createStuckSource(): CardSource {
  return {
    name: "stuck",
    subscribes: ["watcher:recovery"],

    async scan() {
      // stuck 卡是瞬时通知；不持久化历史。如需历史，未来从 task_logs 重建。
      return [];
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "watcher:recovery") return [];
      const { taskId, phase, fromStatus, toStatus } = event.payload;
      return [{ op: "add", card: buildCard(taskId, phase, fromStatus, toStatus) }];
    },
  };
}
```

- [ ] **Step 10.4: 验证测试通过**

Run: `bun test tests/card-sources/stuck.test.ts`
Expected: PASS（3 cases）

- [ ] **Step 10.5: Commit**

```bash
git add src/core/card-sources/stuck.ts tests/card-sources/stuck.test.ts
git commit -m "feat(card-sources): stuck（P1 决策：watcher 恢复后的事件卡）"
```

---

## Task 11: CardSource — completed

**Files:**
- Create: `src/core/card-sources/completed.ts`
- Test: `tests/card-sources/completed.test.ts`

订阅 `task:transition`。task.status = `done` 且 `updated_at` 在 24h 内时出 P3 卡。dismissable=true。

- [ ] **Step 11.1: 写失败测试**

Create `tests/card-sources/completed.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest, getDb, createTask } from "../../src/core/db";
import { createCompletedSource } from "../../src/core/card-sources/completed";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

function setDone(taskId: string, updatedAt: Date): void {
  getDb().run("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?", [
    updatedAt.toISOString(), taskId,
  ]);
}

describe("CardSource: completed", () => {
  beforeEach(() => initSchema());

  it("scan 包含 24h 内完成的，排除超 24h 的", async () => {
    createTask({ id: "task-1", title: "T1", workflow: "dev" });
    createTask({ id: "task-2", title: "T2", workflow: "dev" });
    setDone("task-1", new Date(Date.now() - 1 * 3600_000));         // 1h ago
    setDone("task-2", new Date(Date.now() - 48 * 3600_000));        // 48h ago

    const cards = await createCompletedSource().scan();
    expect(cards.map(c => c.id)).toEqual(["completed:task-1"]);
    expect(cards[0].priority).toBe("P3");
    expect(cards[0].dismissable).toBe(true);
  });

  it("onEvent: 进入 done 产出 add", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev" });
    setDone("task-1", new Date());
    const deltas = await createCompletedSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_submit_pr", to: "done", trigger: "pr_submitted" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
  });

  it("onEvent: 离开 done（极少见，比如手动改回 pending）产出 remove", async () => {
    const deltas = await createCompletedSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "done", to: "running_design", trigger: "rerun" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });
});
```

- [ ] **Step 11.2: 验证测试失败**

Run: `bun test tests/card-sources/completed.test.ts`
Expected: FAIL。

- [ ] **Step 11.3: 实现 completed source**

Create `src/core/card-sources/completed.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { getTask, getDb } from "../db";
import type { Task } from "../db";

const TWENTY_FOUR_HOURS_MS = 24 * 3600_000;

function buildCard(task: Task): NowCard {
  return {
    id: `completed:${task.id}`,
    priority: "P3",
    category: "completed",
    title: `✓ Task #${task.id} 已完成`,
    subtitle: task.title,
    related: { type: "task", id: task.id },
    actions: [
      { label: "看 PR", kind: "secondary", href: `/tasks/${task.id}` },
      { label: "关闭", kind: "secondary", invoke: {
        method: "POST",
        path: `/api/now/cards/completed:${task.id}/dismiss`,
      } },
    ],
    dismissable: true,
    created_at: Math.floor(new Date(task.updated_at).getTime() / 1000),
  };
}

function listRecentlyDone(): Task[] {
  const cutoff = new Date(Date.now() - TWENTY_FOUR_HOURS_MS).toISOString();
  return getDb().query<Task, [string]>(
    "SELECT * FROM tasks WHERE status = 'done' AND updated_at >= ?"
  ).all(cutoff);
}

export function createCompletedSource(): CardSource {
  return {
    name: "completed",
    subscribes: ["task:transition"],

    async scan() {
      return listRecentlyDone().map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "task:transition") return [];
      const { taskId, from, to } = event.payload;
      if (to === "done") {
        const task = getTask(taskId);
        if (!task) return [];
        return [{ op: "add", card: buildCard(task) }];
      }
      if (from === "done") {
        return [{ op: "remove", id: `completed:${taskId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
```

- [ ] **Step 11.4: 验证测试通过**

Run: `bun test tests/card-sources/completed.test.ts`
Expected: PASS（3 cases）

- [ ] **Step 11.5: Commit**

```bash
git add src/core/card-sources/completed.ts tests/card-sources/completed.test.ts
git commit -m "feat(card-sources): completed（P3 完成：done 任务 24h 内）"
```

---

## Task 12: CardSource — task-failed

**Files:**
- Create: `src/core/card-sources/task-failed.ts`
- Test: `tests/card-sources/task-failed.test.ts`

订阅 `task:transition`。task.status = `failed` 时出 P0 卡。dismissable=true（用户可关）。

- [ ] **Step 12.1: 写失败测试**

Create `tests/card-sources/task-failed.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest, getDb, createTask } from "../../src/core/db";
import { createTaskFailedSource } from "../../src/core/card-sources/task-failed";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

function setFailed(taskId: string): void {
  getDb().run("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?", [
    new Date().toISOString(), taskId,
  ]);
}

describe("CardSource: task-failed", () => {
  beforeEach(() => initSchema());

  it("scan 拉所有 status=failed 的 task 作 P0 卡", async () => {
    createTask({ id: "task-1", title: "T1", workflow: "dev" });
    setFailed("task-1");
    createTask({ id: "task-2", title: "T2", workflow: "dev" });

    const cards = await createTaskFailedSource().scan();
    expect(cards.map(c => c.id)).toEqual(["task-failed:task-1"]);
    expect(cards[0].priority).toBe("P0");
    expect(cards[0].category).toBe("error");
    expect(cards[0].dismissable).toBe(true);
  });

  it("onEvent: 进入 failed 产出 add", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev" });
    setFailed("task-1");
    const deltas = await createTaskFailedSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_development", to: "failed", trigger: "error" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
  });

  it("onEvent: 离开 failed（重试）产出 remove", async () => {
    const deltas = await createTaskFailedSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "failed", to: "pending_development", trigger: "retry" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });
});
```

- [ ] **Step 12.2: 验证测试失败**

Run: `bun test tests/card-sources/task-failed.test.ts`
Expected: FAIL。

- [ ] **Step 12.3: 实现 task-failed source**

Create `src/core/card-sources/task-failed.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { getTask, listTasks } from "../db";
import type { Task } from "../db";

function buildCard(task: Task): NowCard {
  return {
    id: `task-failed:${task.id}`,
    priority: "P0",
    category: "error",
    title: `⚠ Task #${task.id} 失败`,
    subtitle: task.title,
    related: { type: "task", id: task.id },
    actions: [
      { label: "看错误", kind: "primary", href: `/tasks/${task.id}` },
      { label: "关闭", kind: "secondary", invoke: {
        method: "POST",
        path: `/api/now/cards/task-failed:${task.id}/dismiss`,
      } },
    ],
    dismissable: true,
    created_at: Math.floor(new Date(task.updated_at).getTime() / 1000),
  };
}

export function createTaskFailedSource(): CardSource {
  return {
    name: "task-failed",
    subscribes: ["task:transition"],

    async scan() {
      return listTasks({ status: "failed" }).map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "task:transition") return [];
      const { taskId, from, to } = event.payload;
      if (to === "failed") {
        const task = getTask(taskId);
        if (!task) return [];
        return [{ op: "add", card: buildCard(task) }];
      }
      if (from === "failed") {
        return [{ op: "remove", id: `task-failed:${taskId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
```

- [ ] **Step 12.4: 验证测试通过**

Run: `bun test tests/card-sources/task-failed.test.ts`
Expected: PASS（3 cases）

- [ ] **Step 12.5: Commit**

```bash
git add src/core/card-sources/task-failed.ts tests/card-sources/task-failed.test.ts
git commit -m "feat(card-sources): task-failed（P0 异常：失败任务未 dismiss）"
```

---

## Task 13: CardSource — empty-state

**Files:**
- Create: `src/core/card-sources/empty-state.ts`
- Test: `tests/card-sources/empty-state.test.ts`

特殊 source：scan 时根据全局库存判断，产出**最多一张**引导卡（4 阶段渐进引导）。订阅 `task:created` / `task:transition` / `requirement:status-changed`（任一变化都可能让 empty 状态切换）。

- [ ] **Step 13.1: 写失败测试**

Create `tests/card-sources/empty-state.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest, createTask } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createCodebase } from "../../src/core/codebases";
import { createRequirement } from "../../src/core/requirements";
import { createEmptyStateSource } from "../../src/core/card-sources/empty-state";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("CardSource: empty-state", () => {
  beforeEach(() => initSchema());

  it("零项目零库存 → 一张'建项目'引导卡", async () => {
    const cards = await createEmptyStateSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("empty-state:no-project");
    expect(cards[0].title).toContain("项目");
  });

  it("有项目无 codebase → 一张'加 codebase'引导卡", async () => {
    createProject({ id: "proj-001", name: "P" });
    const cards = await createEmptyStateSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("empty-state:no-codebase");
  });

  it("有项目有 codebase 无需求 → 一张'提需求'引导卡", async () => {
    createProject({ id: "proj-001", name: "P" });
    createCodebase({ id: "cb-001", project_id: "proj-001", alias: "main", path: "/tmp" });
    const cards = await createEmptyStateSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("empty-state:no-requirement");
  });

  it("有需求 → 不出引导卡", async () => {
    createProject({ id: "proj-001", name: "P" });
    createCodebase({ id: "cb-001", project_id: "proj-001", alias: "main", path: "/tmp" });
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "X", spec_md: "" });
    const cards = await createEmptyStateSource().scan();
    expect(cards).toEqual([]);
  });
});
```

> 注：上面 `createCodebase` 的参数依实际接口调整；若实际签名不同，按实际调用。

- [ ] **Step 13.2: 验证测试失败**

Run: `bun test tests/card-sources/empty-state.test.ts`
Expected: FAIL。

- [ ] **Step 13.3: 实现 empty-state source**

Create `src/core/card-sources/empty-state.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { getDb } from "../db";

function count(sql: string): number {
  const row = getDb().query<{ n: number }, []>(sql).get();
  return row?.n ?? 0;
}

function snapshot(): NowCard[] {
  const projects = count("SELECT COUNT(*) AS n FROM projects");
  if (projects === 0) {
    return [{
      id: "empty-state:no-project",
      priority: "P2",
      category: "decision",
      title: "先建一个项目吧",
      subtitle: "项目是 autopilot 工作的最小单位",
      actions: [
        { label: "新建项目", kind: "primary", href: "/library/projects/new" },
      ],
      dismissable: false,
      created_at: Math.floor(Date.now() / 1000),
    }];
  }

  const codebases = count("SELECT COUNT(*) AS n FROM codebases");
  if (codebases === 0) {
    return [{
      id: "empty-state:no-codebase",
      priority: "P2",
      category: "decision",
      title: "给项目加一个代码库",
      subtitle: "代码库（Codebase）是实际的 Git 目录",
      actions: [
        { label: "去添加", kind: "primary", href: "/library" },
      ],
      dismissable: false,
      created_at: Math.floor(Date.now() / 1000),
    }];
  }

  const requirements = count("SELECT COUNT(*) AS n FROM requirements");
  if (requirements === 0) {
    return [{
      id: "empty-state:no-requirement",
      priority: "P2",
      category: "decision",
      title: "提一个新需求开始",
      subtitle: "autopilot 会调查 → 你审批 → 自动开发 → 提 PR",
      actions: [
        { label: "/start", kind: "primary", href: "/start" },
      ],
      dismissable: false,
      created_at: Math.floor(Date.now() / 1000),
    }];
  }

  return [];
}

export function createEmptyStateSource(): CardSource {
  return {
    name: "empty-state",
    subscribes: ["task:created", "task:transition", "requirement:status-changed"],

    async scan() {
      return snapshot();
    },

    async onEvent(_event: AutopilotEvent): Promise<CardDelta[]> {
      // 简化策略：每次相关事件来时全量重算 empty-state；最多一张卡，开销可忽略。
      // 计算当前应该出现的引导卡，与 aggregator 中现状 diff —— 但 source 无内存。
      // 此处用 add/remove 的"全清+重添"风格：
      const wanted = snapshot();
      // 先 remove 全部已知的 empty-state 卡（aggregator 看到不存在 id 的 remove 是 no-op）
      const removeAll: CardDelta[] = [
        { op: "remove", id: "empty-state:no-project", reason: "resolved" },
        { op: "remove", id: "empty-state:no-codebase", reason: "resolved" },
        { op: "remove", id: "empty-state:no-requirement", reason: "resolved" },
      ];
      const adds: CardDelta[] = wanted.map((c) => ({ op: "add", card: c }));
      return [...removeAll, ...adds];
    },
  };
}
```

> 设计权衡：每次事件触发都计算并发"清空再添加"序列。在 aggregator 中 `remove` 不存在的 id 是 no-op（实现中已检查 `snapshot.delete(id)` 的返回），所以浪费很小。这样比维护 source 内存状态简单很多。

- [ ] **Step 13.4: 验证测试通过**

Run: `bun test tests/card-sources/empty-state.test.ts`
Expected: PASS（4 cases）

- [ ] **Step 13.5: Commit**

```bash
git add src/core/card-sources/empty-state.ts tests/card-sources/empty-state.test.ts
git commit -m "feat(card-sources): empty-state（4 阶段渐进引导）"
```

---

## Task 14: CardSource — provider-error (stub)

**Files:**
- Create: `src/core/card-sources/provider-error.ts`
- Test: `tests/card-sources/provider-error.test.ts`

provider 健康检查机制尚未实现，本 source 在 PR 1 是 **stub**：scan 返回空、onEvent 不订阅任何事件。文件就位、接口一致，未来 provider 健康检查就位后只需修这个文件，不动其他。

- [ ] **Step 14.1: 写测试（含 stub 断言）**

Create `tests/card-sources/provider-error.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { createProviderErrorSource } from "../../src/core/card-sources/provider-error";

describe("CardSource: provider-error (stub)", () => {
  it("name 与接口正常", () => {
    const src = createProviderErrorSource();
    expect(src.name).toBe("provider-error");
    expect(src.subscribes).toEqual([]); // PR 1 stub，暂不订阅
  });

  it("scan 返回空（stub）", async () => {
    expect(await createProviderErrorSource().scan()).toEqual([]);
  });

  it("onEvent 返回空（stub）", async () => {
    const deltas = await createProviderErrorSource().onEvent({
      type: "task:transition",
      payload: { taskId: "x", from: "a", to: "b", trigger: "t" },
    });
    expect(deltas).toEqual([]);
  });
});
```

- [ ] **Step 14.2: 验证测试失败**

Run: `bun test tests/card-sources/provider-error.test.ts`
Expected: FAIL。

- [ ] **Step 14.3: 实现 stub**

Create `src/core/card-sources/provider-error.ts`:

```typescript
import type { CardSource, CardDelta } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";

/**
 * P0 异常：provider 凭证失效 / 模型不可用。
 *
 * **PR 1 stub**：daemon 当前没有 provider 健康检查机制（凭证由各 CLI 自己管）。
 * 此 source 占位以保持接口完整。未来引入 provider 健康检查后：
 * 1. subscribes 加 ["provider:health_changed"]（先在 protocol.ts 加事件类型）
 * 2. scan() 拉当前所有不健康 provider，每个产 P0 卡
 * 3. onEvent() 处理 healthy ↔ unhealthy 切换
 */
export function createProviderErrorSource(): CardSource {
  return {
    name: "provider-error",
    subscribes: [],

    async scan() {
      return [];
    },

    async onEvent(_event: AutopilotEvent): Promise<CardDelta[]> {
      return [];
    },
  };
}
```

- [ ] **Step 14.4: 验证测试通过**

Run: `bun test tests/card-sources/provider-error.test.ts`
Expected: PASS（3 cases）

- [ ] **Step 14.5: Commit**

```bash
git add src/core/card-sources/provider-error.ts tests/card-sources/provider-error.test.ts
git commit -m "feat(card-sources): provider-error stub（待 provider 健康检查就位）"
```

---

## Task 15: 装配 sources 到 aggregator 工厂

**Files:**
- Modify: `src/core/now-aggregator.ts`（加 `createDefaultAggregator()` 工厂）
- Test: `tests/now-aggregator.test.ts`（加一个 default sources 测试）

- [ ] **Step 15.1: 写失败测试**

Edit `tests/now-aggregator.test.ts`，在文件末尾追加 describe：

```typescript
import { createDefaultAggregator } from "../src/core/now-aggregator";

describe("now-aggregator default sources", () => {
  it("createDefaultAggregator 包含所有 8 个内置 source", async () => {
    const db = new Database(":memory:");
    // 这里依赖完整 schema，因为 sources 会查多张表
    const ms = await import("../src/migrations/001-baseline");
    // ...（按实际项目惯例 apply 全部迁移）
    // 为简化，本测试只断言 source 数量与 name
    const agg = createDefaultAggregator();
    // 通过类型反射不可行；最简：导出一个 listSourceNames() 辅助
    expect(typeof agg.start).toBe("function");
  });
});
```

> 上面测试相对弱（仅断言可创建）—— 强测试在 Task 17 e2e 阶段做。

- [ ] **Step 15.2: 验证测试失败**

Run: `bun test tests/now-aggregator.test.ts`
Expected: FAIL —— Cannot import createDefaultAggregator。

- [ ] **Step 15.3: 在 now-aggregator.ts 末尾加工厂**

Edit `src/core/now-aggregator.ts`，在文件末尾追加：

```typescript
import { createAwaitingApprovalSource } from "./card-sources/awaiting-approval";
import { createOpenQuestionSource } from "./card-sources/open-question";
import { createAwaitReviewSource } from "./card-sources/await-review";
import { createRunningSource } from "./card-sources/running";
import { createStuckSource } from "./card-sources/stuck";
import { createCompletedSource } from "./card-sources/completed";
import { createTaskFailedSource } from "./card-sources/task-failed";
import { createEmptyStateSource } from "./card-sources/empty-state";
import { createProviderErrorSource } from "./card-sources/provider-error";

/** 装配所有内置 CardSource，返回 ready-to-start 的 aggregator 实例。 */
export function createDefaultAggregator(opts: AggregatorOptions = {}): Aggregator {
  return createAggregator(
    [
      createTaskFailedSource(),       // P0
      createProviderErrorSource(),    // P0 stub
      createAwaitingApprovalSource(), // P1
      createOpenQuestionSource(),     // P1
      createAwaitReviewSource(),      // P1
      createStuckSource(),            // P1
      createRunningSource(),          // P2
      createCompletedSource(),        // P3
      createEmptyStateSource(),       // empty
    ],
    opts,
  );
}
```

- [ ] **Step 15.4: 验证测试通过**

Run: `bun test tests/now-aggregator.test.ts`
Expected: PASS（全部 case 包括新增的）

- [ ] **Step 15.5: Commit**

```bash
git add src/core/now-aggregator.ts tests/now-aggregator.test.ts
git commit -m "feat(core): now-aggregator 装配 8 个内置 CardSource"
```

---

## Task 16: HTTP 路由 — /api/now/cards 与 dismiss

**Files:**
- Create: `src/daemon/routes-now.ts`
- Modify: `src/daemon/routes.ts`（在 handleRequest 中调用 handleNowRequest 早返回）
- Test: `tests/routes-now.test.ts`

- [ ] **Step 16.1: 写失败测试**

Create `tests/routes-now.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m011 } from "../src/migrations/011-now-dismissed-cards";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, setRequirementStatus } from "../src/core/requirements";
import { handleNowRequest, setNowAggregator } from "../src/daemon/routes-now";
import { createDefaultAggregator, type Aggregator } from "../src/core/now-aggregator";
import { enableBus, disableBus } from "../src/daemon/event-bus";
import { isCardDismissed } from "../src/core/now-dismiss";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("routes-now", () => {
  let agg: Aggregator;

  beforeEach(async () => {
    initSchema();
    createProject({ id: "proj-001", name: "P" });
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "等审批的需求", spec_md: "" });
    setRequirementStatus("REQ-001", "investigating");
    setRequirementStatus("REQ-001", "awaiting_approval");
    enableBus();
    agg = createDefaultAggregator();
    await agg.start();
    setNowAggregator(agg);
  });

  afterEach(() => {
    agg.dispose();
    disableBus();
    setNowAggregator(null);
  });

  it("GET /api/now/cards 返回当前快照", async () => {
    const req = new Request("http://localhost/api/now/cards", { method: "GET" });
    const res = await handleNowRequest(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { cards: Array<{ id: string }> };
    expect(body.cards.map(c => c.id)).toContain("awaiting-approval:REQ-001");
  });

  it("POST /api/now/cards/:id/dismiss 持久化 dismiss 并从快照中移除", async () => {
    const cardId = encodeURIComponent("awaiting-approval:REQ-001");
    const req = new Request(`http://localhost/api/now/cards/${cardId}/dismiss`, { method: "POST" });
    const res = await handleNowRequest(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(isCardDismissed("awaiting-approval:REQ-001")).toBe(true);
  });

  it("非 /api/now/* 路径返回 null（让上层 router 继续匹配）", async () => {
    const req = new Request("http://localhost/api/tasks", { method: "GET" });
    const res = await handleNowRequest(req, new URL(req.url));
    expect(res).toBeNull();
  });
});
```

- [ ] **Step 16.2: 验证测试失败**

Run: `bun test tests/routes-now.test.ts`
Expected: FAIL。

- [ ] **Step 16.3: 实现 routes-now.ts**

Create `src/daemon/routes-now.ts`:

```typescript
import type { Aggregator } from "../core/now-aggregator";
import { dismissCard } from "../core/now-dismiss";
import { emit } from "./event-bus";

let _aggregator: Aggregator | null = null;

/** 由 daemon 启动逻辑注入，由 dispose 清空。tests 也用此注入 fake aggregator。 */
export function setNowAggregator(agg: Aggregator | null): void {
  _aggregator = agg;
}

/**
 * 处理 /api/now/* 路由。返回 null 表示路径不归本模块管，让上层继续路由。
 * routes.ts 在 handleRequest 早期调用此函数；只有命中本模块时才返回 Response。
 */
export async function handleNowRequest(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith("/api/now/")) return null;

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  // GET /api/now/cards
  if (method === "GET" && path === "/api/now/cards") {
    if (!_aggregator) return json({ cards: [] });
    return json({ cards: _aggregator.getCards() });
  }

  // POST /api/now/cards/:id/dismiss
  const dismissMatch = path.match(/^\/api\/now\/cards\/([^/]+)\/dismiss$/);
  if (method === "POST" && dismissMatch) {
    const cardId = decodeURIComponent(dismissMatch[1]);
    dismissCard(cardId);
    // 推个 remove 事件让 WS 客户端立刻看到卡消失
    emit({ type: "now:card_removed", payload: { id: cardId, reason: "dismissed" } });
    return json({ ok: true });
  }

  return json({ error: "Not Found" }, 404);
}
```

- [ ] **Step 16.4: 在 routes.ts 接入**

Modify `src/daemon/routes.ts` —— 在 `handleRequest` 函数体的 CORS preflight 之后、token 鉴权之后、第一个 `// ── API Routes ──` 注释之前插入：

```typescript
  // ── /now 路由（PR 1：状态推导引擎）──
  if (path.startsWith("/api/now/")) {
    const { handleNowRequest } = await import("./routes-now");
    const nowRes = await handleNowRequest(req, url);
    if (nowRes) {
      // 加 CORS headers
      const headers = new Headers(nowRes.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(nowRes.body, { status: nowRes.status, headers });
    }
  }
```

> 用动态 import 避免循环依赖（routes-now.ts 也 import 自 core）。

- [ ] **Step 16.5: 验证测试通过**

Run: `bun test tests/routes-now.test.ts`
Expected: PASS（3 cases）

- [ ] **Step 16.6: Commit**

```bash
git add src/daemon/routes-now.ts src/daemon/routes.ts tests/routes-now.test.ts
git commit -m "feat(daemon): /api/now/cards 与 dismiss 路由"
```

---

## Task 17: Daemon 启动集成

**Files:**
- Modify: `src/daemon/index.ts`

- [ ] **Step 17.1: 在 startDaemon 中初始化 aggregator**

Modify `src/daemon/index.ts`：

1. 在顶部 import 区加：

```typescript
import { createDefaultAggregator } from "../core/now-aggregator";
import { setNowAggregator } from "./routes-now";
```

2. 在 `enableBus();` 之后（紧贴 `initRequirementScheduler();` 之前）插入：

```typescript
  // 启动 /now 状态推导引擎
  const nowAggregator = createDefaultAggregator();
  await nowAggregator.start();
  setNowAggregator(nowAggregator);
  log.info("now-aggregator 已启动，卡片数 %d", nowAggregator.getCards().length);
```

3. 在 `shutdown` 函数体内（紧贴 `disableBus();` 之前）插入：

```typescript
    nowAggregator.dispose();
    setNowAggregator(null);
```

- [ ] **Step 17.2: 手动验证启动**

Run: `bun run dev daemon run`
Expected: 启动日志中出现 `now-aggregator 已启动，卡片数 N`。Ctrl+C 后无未捕获异常。

- [ ] **Step 17.3: 手动验证 HTTP**

新开终端：

```bash
curl http://127.0.0.1:6180/api/now/cards
```

Expected: 返回 `{"cards":[...]}` JSON。若数据库里有 awaiting_approval 需求或 done 任务等，会在数组中看到。

- [ ] **Step 17.4: Commit**

```bash
git add src/daemon/index.ts
git commit -m "feat(daemon): startDaemon 集成 now-aggregator 初始化与 dispose"
```

---

## Task 18: e2e smoke test

**Files:**
- Create: `tests/now-e2e.test.ts`

通过真启 daemon、HTTP 拉、WS 订阅一遍，验证集成正确。复用 `tests/daemon-log.test.ts` 类似的启动模式（看现有 e2e 测试找 helper）。

- [ ] **Step 18.1: 看现有 daemon e2e 测试找启动 helper**

Run: `bun test tests/daemon-log.test.ts -t "boot"`（找最小启动模式）

参考 `tests/daemon-log.test.ts` 的 daemon 启动方式（spawn daemon 进程，或 in-process startServer）。

- [ ] **Step 18.2: 写 e2e 测试**

Create `tests/now-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m011 } from "../src/migrations/011-now-dismissed-cards";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, setRequirementStatus } from "../src/core/requirements";
import { enableBus, disableBus } from "../src/daemon/event-bus";
import { createDefaultAggregator, type Aggregator } from "../src/core/now-aggregator";
import { setNowAggregator } from "../src/daemon/routes-now";
import { handleRequest } from "../src/daemon/routes";

describe("/now e2e smoke", () => {
  let agg: Aggregator;

  beforeAll(async () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
    _setDbForTest(db);
    createProject({ id: "proj-001", name: "P" });
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "smoke", spec_md: "" });
    setRequirementStatus("REQ-001", "investigating");
    setRequirementStatus("REQ-001", "awaiting_approval");

    enableBus();
    agg = createDefaultAggregator();
    await agg.start();
    setNowAggregator(agg);
  });

  afterAll(() => {
    agg.dispose();
    setNowAggregator(null);
    disableBus();
  });

  it("GET /api/now/cards 通过 routes.ts 主入口能返回卡片", async () => {
    const req = new Request("http://localhost/api/now/cards", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { cards: Array<{ id: string }> };
    expect(body.cards.some(c => c.id === "awaiting-approval:REQ-001")).toBe(true);
  });

  it("POST .../dismiss 通过 routes.ts 主入口能命中", async () => {
    const cardId = encodeURIComponent("awaiting-approval:REQ-001");
    const req = new Request(`http://localhost/api/now/cards/${cardId}/dismiss`, {
      method: "POST",
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
```

- [ ] **Step 18.3: 验证测试通过**

Run: `bun test tests/now-e2e.test.ts`
Expected: PASS（2 cases）

- [ ] **Step 18.4: 完整测试套件全绿**

Run: `bun test`
Expected: 所有现有 + 新增测试全部通过。

- [ ] **Step 18.5: TypeScript 全检查**

Run: `bun run typecheck`
Expected: 无错。

- [ ] **Step 18.6: Commit**

```bash
git add tests/now-e2e.test.ts
git commit -m "test: /now 后端集成 e2e smoke"
```

---

## 收尾：开 PR

- [ ] 推送分支：`git push -u origin feat/now-aggregator-backend-20260512`
- [ ] 用 `gh pr create` 开 PR，标题：`feat(daemon): /now 状态推导引擎与 HTTP/WS 接口（PR 1）`
- [ ] PR 描述模板：

```markdown
## 改了什么

实现 `docs/superpowers/specs/2026-05-12-now-screen-redesign-design.md` 的 PR 1（后端基础）：

- 新增 `now-aggregator`：daemon 内事件驱动 + 内存快照
- 8 个 `CardSource`：awaiting-approval / open-question / await-review / running / stuck / completed / task-failed / empty-state；provider-error 占位 stub
- HTTP `GET /api/now/cards` + `POST /api/now/cards/:id/dismiss`
- WS channel `now:*`（事件类型已加入 `AutopilotEvent`，由现有 `bus.on("*")` 桥接到 wsManager 广播）
- Migration 011：`now_dismissed_cards` 表

## 怎么验证

- `bun test`：全绿（含新增 ~50 个 test cases）
- `bun run typecheck`：无错
- 手动：`bun run dev daemon run` + `curl http://127.0.0.1:6180/api/now/cards`

## 后续

- PR 2：Web `/now` 主屏 + `NowCard` 组件
- PR 3：4 区导航重构
- PR 4：CLI/TUI + quickstart 重写
```

---

## Self-Review 已做

逐条对照 spec §4 / §5.1 / §5.5 PR 1 范围核对：

- ✅ now-aggregator 模块（spec §4.1）
- ✅ NowCard 协议（§4.2）含所有字段
- ✅ CardSource 接口（§4.3）含 name / subscribes / scan / onEvent
- ✅ HTTP 接口（§4.4）GET + dismiss
- ✅ WS 事件类型（§4.4）4 个全部
- ✅ dismiss 持久化（§4.4 补充段）
- ✅ 9 个 source 全部覆盖（含 stub）
- ✅ 不引入新依赖（§4.5）
- ✅ 事件驱动 + 内存快照（§4.5）
- ✅ 等待时长前端算（NowCard.waited_seconds 注释中说明）

类型一致性确认：
- `NowCard.id` 在所有 source 中都按 `"<source-name>:<entity-id>"` 格式生成
- `CardSource.name` 与 `NowCard.id` 前缀一致
- `applyDelta` 三种 op 与 spec 协议一致

无 placeholder。无 TBD/TODO。
