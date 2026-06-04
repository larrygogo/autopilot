/**
 * now.* RPC method 端到端测试（之前测 HTTP /api/now/* 路由）。
 * HTTP endpoint 已删除，业务逻辑通过 invokeRpcMethod 走 WS RPC。
 */

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
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, setRequirementStatus } from "../src/core/requirements";
import { setNowAggregator } from "../src/daemon/routes-now";
import { createDefaultAggregator, type Aggregator } from "../src/core/now-aggregator";
import { enableBus, disableBus } from "../src/core/event-bus";
import { isCardDismissed } from "../src/core/now-dismiss";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m024].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("now.* RPC", () => {
  let agg: Aggregator;

  beforeEach(async () => {
    initSchema();
    registerCoreRpcMethods();
    createProject({ id: "proj-001", name: "P" });
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "等审批的需求", spec_md: "" });
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

  it("now.cards 返回当前快照", async () => {
    const r = await invokeRpcMethod("now.cards", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cards = r.payload as Array<{ id: string }>;
      expect(cards.map(c => c.id)).toContain("awaiting-approval:REQ-001");
    }
  });

  it("now.dismissCard 持久化 dismiss 并从快照中移除", async () => {
    const r = await invokeRpcMethod("now.dismissCard", { id: "awaiting-approval:REQ-001" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { ok: boolean };
      expect(body.ok).toBe(true);
    }
    expect(isCardDismissed("awaiting-approval:REQ-001")).toBe(true);
    expect(agg.getCards().map(c => c.id)).not.toContain("awaiting-approval:REQ-001");
  });

  it("now.dismissCard 缺 id → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("now.dismissCard", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });
});
