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
import { up as m019 } from "../../src/migrations/019-task-requirement-id";
import { up as m021 } from "../../src/migrations/021-requirement-comments";
import { up as m012 } from "../../src/migrations/012-spec-revisions";
import { up as m013 } from "../../src/migrations/013-active-question-id";
import { up as m014 } from "../../src/migrations/014-resolve-orphan-open-questions";
import { up as m015 } from "../../src/migrations/015-clarifier-error";
import { up as m024 } from "../../src/migrations/024-codebase-to-workspace";
import { _setDbForTest } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createRequirement, updateRequirement } from "../../src/core/requirements";
import { createClarifierErrorSource } from "../../src/core/card-sources/clarifier-error";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m019, m021, m024].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("CardSource: clarifier-error", () => {
  beforeEach(() => initSchema());

  it("name='clarifier-error'，订阅 clarifier-error + 3 个 'progress' 事件", () => {
    const src = createClarifierErrorSource();
    expect(src.name).toBe("clarifier-error");
    expect(src.subscribes).toContain("requirement:clarifier-error");
    expect(src.subscribes).toContain("requirement:spec-revised");
    expect(src.subscribes).toContain("requirement:active-question-changed");
    expect(src.subscribes).toContain("requirement:status-changed");
  });

  it("scan 从 DB 拉所有 clarifier_error 非空的 requirements 出 P0 卡", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T1", spec_md: "" });
    createRequirement({ id: "r2", project_id: "p1", title: "T2", spec_md: "" });
    updateRequirement("r1", { clarifier_error: "AI 超时" });
    // r2 不设错误

    const cards = await createClarifierErrorSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("clarifier-error:r1");
    expect(cards[0].priority).toBe("P0");
    expect(cards[0].category).toBe("error");
    expect(cards[0].dismissable).toBe(false);
    expect(cards[0].subtitle).toContain("AI 超时");
    const hasView = cards[0].actions.some(a => a.intent.kind === "view_requirement" && a.intent.requirementId === "r1");
    const hasRetry = cards[0].actions.some(a => a.intent.kind === "retry_clarify" && a.intent.requirementId === "r1");
    expect(hasView).toBe(true);
    expect(hasRetry).toBe(true);
  });

  it("onEvent: clarifier-error → P0 add 卡", async () => {
    const deltas = await createClarifierErrorSource().onEvent({
      type: "requirement:clarifier-error",
      payload: { id: "r1", reason: "JSON parse failed" },
    });
    expect(deltas).toHaveLength(1);
    if (deltas[0].op === "add") {
      expect(deltas[0].card.id).toBe("clarifier-error:r1");
      expect(deltas[0].card.subtitle).toContain("JSON parse failed");
    }
  });

  it("onEvent: spec-revised → remove（clarifier 取得进展，清错误卡）", async () => {
    const deltas = await createClarifierErrorSource().onEvent({
      type: "requirement:spec-revised",
      payload: { id: "r1", revision_id: 5 },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") expect(deltas[0].id).toBe("clarifier-error:r1");
  });

  it("onEvent: active-question-changed → remove", async () => {
    const deltas = await createClarifierErrorSource().onEvent({
      type: "requirement:active-question-changed",
      payload: { id: "r1", question_id: "q1" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });

  it("onEvent: status-changed → remove", async () => {
    const deltas = await createClarifierErrorSource().onEvent({
      type: "requirement:status-changed",
      payload: { id: "r1", from: "clarifying", to: "awaiting_approval" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });
});
