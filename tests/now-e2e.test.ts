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
import { enableBus, disableBus } from "../src/core/event-bus";
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
