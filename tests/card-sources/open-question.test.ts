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
import { up as m024 } from "../../src/migrations/024-codebase-to-workspace";
import { _setDbForTest } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createRequirement, setRequirementStatus, setActiveQuestionId } from "../../src/core/requirements";
import { createQuestion } from "../../src/core/requirement-questions";
import { createOpenQuestionSource } from "../../src/core/card-sources/open-question";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m019, m021, m024].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("CardSource: open-question (按 req_id 出卡)", () => {
  beforeEach(() => initSchema());

  it("name='open-question'，订阅 active-question-changed / status-changed", () => {
    const src = createOpenQuestionSource();
    expect(src.name).toBe("open-question");
    expect(src.subscribes).toContain("requirement:active-question-changed");
    expect(src.subscribes).toContain("requirement:status-changed");
  });

  it("scan 只返回 status=clarifying && active_question_id 非空的 req，每 req 1 卡", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "需求一", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "目标用户是谁？" });
    setActiveQuestionId("r1", "q1");

    createRequirement({ id: "r2", project_id: "p1", title: "需求二", spec_md: "" });
    createQuestion({ id: "q2", requirement_id: "r2", agent_text: "x?" });
    // r2 不在 clarifying

    createRequirement({ id: "r3", project_id: "p1", title: "需求三", spec_md: "" });
    setRequirementStatus("r3", "clarifying");
    // r3 在 clarifying 但没 active

    const cards = await createOpenQuestionSource().scan();
    expect(cards.map(c => c.id)).toEqual(["open-question:r1"]);
    expect(cards[0].priority).toBe("P1");
    expect(cards[0].category).toBe("decision");
    expect(cards[0].subtitle).toContain("目标用户是谁");
    expect(cards[0].related).toEqual({ type: "requirement", id: "r1" });
    expect(cards[0].actions.find(a => a.kind === "primary")?.intent).toEqual({ kind: "view_requirement", requirementId: "r1" });
  });

  it("onEvent: active-question-changed 到非 null → add", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");

    const src = createOpenQuestionSource();
    const deltas = await src.onEvent({
      type: "requirement:active-question-changed",
      payload: { id: "r1", question_id: "q1" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
    if (deltas[0].op === "add") expect(deltas[0].card.id).toBe("open-question:r1");
  });

  it("onEvent: active-question-changed 到 null → remove", async () => {
    const src = createOpenQuestionSource();
    const deltas = await src.onEvent({
      type: "requirement:active-question-changed",
      payload: { id: "r1", question_id: null },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") expect(deltas[0].id).toBe("open-question:r1");
  });

  it("onEvent: status-changed 离开 clarifying → remove", async () => {
    const src = createOpenQuestionSource();
    const deltas = await src.onEvent({
      type: "requirement:status-changed",
      payload: { id: "r1", from: "clarifying", to: "awaiting_approval" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });
});
