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
import { enableBus, disableBus } from "../src/core/event-bus";
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
    // 从 aggregator 快照里移除
    expect(agg.getCards().map(c => c.id)).not.toContain("awaiting-approval:REQ-001");
  });

  it("非 /api/now/* 路径返回 null", async () => {
    const req = new Request("http://localhost/api/tasks", { method: "GET" });
    const res = await handleNowRequest(req, new URL(req.url));
    expect(res).toBeNull();
  });
});
