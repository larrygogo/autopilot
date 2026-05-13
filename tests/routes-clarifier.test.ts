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
import { up as m012 } from "../src/migrations/012-spec-revisions";
import { up as m013 } from "../src/migrations/013-active-question-id";
import { up as m014 } from "../src/migrations/014-resolve-orphan-open-questions";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, setRequirementStatus, getRequirementById, setActiveQuestionId } from "../src/core/requirements";
import { createQuestion } from "../src/core/requirement-questions";
import { createSpecRevision } from "../src/core/spec-revisions";
import { handleRequest } from "../src/daemon/routes";
import { enableBus, disableBus } from "../src/core/event-bus";
import { _setClarifyFnForTest } from "../src/daemon/requirement-clarifier";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("clarifier routes", () => {
  beforeEach(() => {
    initSchema();
    enableBus();
  });
  afterEach(() => {
    _setClarifyFnForTest(null);
    disableBus();
  });

  it("POST /api/requirements/:id/finish-clarification → awaiting_approval + active=null", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");

    const req = new Request("http://localhost/api/requirements/r1/finish-clarification", { method: "POST" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { requirement: { status: string; active_question_id: string | null } };
    expect(body.requirement.status).toBe("awaiting_approval");
    expect(body.requirement.active_question_id).toBeNull();
  });

  it("POST /api/requirements/:id/retry-clarify → 触发 runClarifierRound", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");

    let invoked = false;
    _setClarifyFnForTest(async () => {
      invoked = true;
      return JSON.stringify({ new_spec_md: "重写后", summary: "重做", next_question: { agent_text: "新问题?", suggestions: [] }, done: false });
    });

    const req = new Request("http://localhost/api/requirements/r1/retry-clarify", { method: "POST" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    expect(invoked).toBe(true);

    const r = getRequirementById("r1");
    expect(r?.spec_md).toBe("重写后");
    expect(r?.active_question_id).toBeTruthy();
  });

  it("GET /api/requirements/:id/spec-revisions → 历史列表", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "v3" });
    createSpecRevision({
      requirement_id: "r1",
      before_md: "v1",
      after_md: "v2",
      summary: "首次修订",
      source: "clarifier",
      triggered_by_question_id: null,
    });
    await new Promise(r => setTimeout(r, 2));
    createSpecRevision({
      requirement_id: "r1",
      before_md: "v2",
      after_md: "v3",
      summary: "二次修订",
      source: "clarifier",
      triggered_by_question_id: null,
    });

    const req = new Request("http://localhost/api/requirements/r1/spec-revisions", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { revisions: Array<{ id: number; summary: string | null; after_md: string }> };
    expect(body.revisions).toHaveLength(2);
    expect(body.revisions[0].summary).toBe("二次修订");
    expect(body.revisions[1].summary).toBe("首次修订");
  });

  it("POST /api/requirements/:id/finish-clarification 不存在的 req → 404", async () => {
    const req = new Request("http://localhost/api/requirements/non-existent/finish-clarification", { method: "POST" });
    const res = await handleRequest(req);
    expect(res.status).toBe(404);
  });
});
