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
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, setRequirementStatus } from "../src/core/requirements";
import { enableBus, disableBus } from "../src/core/event-bus";
import { createDefaultAggregator, type Aggregator } from "../src/core/now-aggregator";
import { setNowAggregator } from "../src/daemon/routes-now";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

describe("/now e2e smoke (RPC)", () => {
  let agg: Aggregator;

  beforeAll(async () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m024].forEach(fn => fn(db));
    _setDbForTest(db);
    registerCoreRpcMethods();
    createProject({ id: "proj-001", name: "P" });
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "smoke", spec_md: "" });
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

  it("now.cards RPC 返回卡片列表", async () => {
    const r = await invokeRpcMethod("now.cards", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cards = r.payload as Array<{ id: string }>;
      expect(cards.some(c => c.id === "awaiting-approval:REQ-001")).toBe(true);
    }
  });

  it("now.dismissCard RPC 能命中并持久化 dismiss", async () => {
    const r = await invokeRpcMethod("now.dismissCard", { id: "awaiting-approval:REQ-001" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { ok: boolean };
      expect(body.ok).toBe(true);
    }
  });
});
