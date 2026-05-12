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

  it("onEvent 收到 questions-updated 重扫该 requirement 的 open questions（输出 add）", async () => {
    createQuestion({ id: "QST-001", requirement_id: "REQ-001", agent_text: "Q1?" });
    const src = createOpenQuestionSource();
    const deltas = await src.onEvent({
      type: "requirement:questions-updated",
      payload: { id: "REQ-001" },
    });
    expect(deltas.some(d => d.op === "add" && d.card.id === "open-question:QST-001")).toBe(true);
  });

  it("onEvent 收到 all-questions-resolved 输出 remove 该 requirement 的卡", async () => {
    createQuestion({ id: "QST-001", requirement_id: "REQ-001", agent_text: "Q1?" });
    const src = createOpenQuestionSource();
    // 先让 source 知道 QST-001
    await src.onEvent({ type: "requirement:questions-updated", payload: { id: "REQ-001" } });
    resolveQuestion("QST-001");
    const deltas = await src.onEvent({
      type: "requirement:all-questions-resolved",
      payload: { id: "REQ-001" },
    });
    expect(deltas.some(d => d.op === "remove" && d.id === "open-question:QST-001")).toBe(true);
  });
});
