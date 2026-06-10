import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate011 } from "../src/migrations/011-now-dismissed-cards";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { _setDbForTest } from "../src/core/db";
import {
  createAggregator,
  type Aggregator,
  type AggregatorOptions,
} from "../src/core/now-aggregator";
import { dismissCard, isCardDismissed } from "../src/core/now-dismiss";
import type { CardSource, NowCard, CardDelta } from "../src/core/now-types";
import { enableBus, disableBus, emit } from "../src/core/event-bus";

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
    migrate024(db);
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
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x", note: null } });
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
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x", note: null } });
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
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x", note: null } });
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
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x", note: null } });
    await new Promise(r => setTimeout(r, 10));
    expect(count).toBe(0);
    agg = undefined as unknown as Aggregator;
  });

  it("start 重复调用是幂等（不重复挂监听）", async () => {
    let count = 0;
    const src: CardSource = {
      name: "fake",
      subscribes: ["task:transition"],
      scan: async () => [],
      onEvent: async () => { count++; return []; },
    };
    agg = createAggregator([src]);
    await agg.start();
    await agg.start(); // 重复 start
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x", note: null } });
    await new Promise(r => setTimeout(r, 10));
    expect(count).toBe(1); // 只触发一次，证明 handler 没被重复挂
  });

  it("markDismissed 把卡从快照里移除并 emit card_removed", async () => {
    const events: Array<{ type: string; id?: string; reason?: string }> = [];
    const src: CardSource = {
      name: "fake",
      subscribes: [],
      scan: async () => [card("fake:x", "P1")],
      onEvent: async () => [],
    };
    agg = createAggregator([src], {
      emit: (e) => {
        if (e.type === "now:card_removed") {
          events.push({ type: e.type, id: e.payload.id, reason: e.payload.reason });
        }
      },
    });
    await agg.start();
    expect(agg.getCards().map(c => c.id)).toContain("fake:x");
    agg.markDismissed("fake:x");
    expect(agg.getCards()).toEqual([]);
    expect(events).toEqual([{ type: "now:card_removed", id: "fake:x", reason: "dismissed" }]);
  });

  it("markDismissed 后续 add 不再产出", async () => {
    const src: CardSource = {
      name: "fake",
      subscribes: ["task:transition"],
      scan: async () => [],
      onEvent: async () => {
        // 模拟事件再次添加同 id
        return [{ op: "add", card: card("fake:x", "P1") }];
      },
    };
    agg = createAggregator([src]);
    await agg.start();
    agg.markDismissed("fake:x");
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x", note: null } });
    await new Promise(r => setTimeout(r, 10));
    expect(agg.getCards()).toEqual([]);
  });

  it("clear-dismiss 清掉内存 dismissedIds 与 DB 记录", async () => {
    const src: CardSource = {
      name: "fake",
      subscribes: [],
      scan: async () => [],
      onEvent: async () => [],
    };
    dismissCard("fake:x");
    agg = createAggregator([src]);
    await agg.start();
    // 内存 Set 已加载 fake:x，应过滤掉
    expect(isCardDismissed("fake:x")).toBe(true);
    // 手动触发 clear-dismiss delta（生产中由 source 返回）
    // 通过 source 触发：
    const src2: CardSource = {
      name: "fake2",
      subscribes: ["task:transition"],
      scan: async () => [],
      onEvent: async () => [{ op: "clear-dismiss", id: "fake:x" }],
    };
    agg.dispose();
    agg = createAggregator([src, src2]);
    await agg.start();
    emit({ type: "task:transition", payload: { taskId: "t1", from: "a", to: "b", trigger: "x", note: null } });
    await new Promise(r => setTimeout(r, 10));
    expect(isCardDismissed("fake:x")).toBe(false);
  });
});

describe("createDefaultAggregator", () => {
  it("可以创建并启动一个含全部内置 sources 的 aggregator", async () => {
    // 需要完整 schema（多个 sources 查多张表）
    const db = new Database(":memory:");
    const ms = await Promise.all([
      import("../src/migrations/001-baseline"),
      import("../src/migrations/002-schedules"),
      import("../src/migrations/004-repos"),
      import("../src/migrations/005-requirements"),
      import("../src/migrations/006-submodules"),
      import("../src/migrations/007-workflows"),
      import("../src/migrations/008-projects"),
      import("../src/migrations/009-nullable-codebase"),
      import("../src/migrations/010-question-suggestions"),
      import("../src/migrations/011-now-dismissed-cards"),
    ]);
    for (const m of ms) (m as { up: (db: Database) => void }).up(db);
    _setDbForTest(db);
    enableBus();

    const { createDefaultAggregator } = await import("../src/core/now-aggregator");
    const dagg = createDefaultAggregator();
    await dagg.start();
    // 空环境下应至少有 empty-state 卡（no-project 引导）
    const cards = dagg.getCards();
    expect(cards.some(c => c.id.startsWith("empty-state:"))).toBe(true);
    dagg.dispose();
    disableBus();
  });
});
