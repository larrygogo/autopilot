import { describe, it, expect, beforeEach } from "bun:test";
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
import {
  createRequirement,
  getRequirementById,
  setActiveQuestionId,
  finishClarification,
  setRequirementStatus,
} from "../src/core/requirements";
import { createQuestion, getQuestionById } from "../src/core/requirement-questions";
import { enableBus, disableBus, onEvent, offEvent } from "../src/core/event-bus";
import type { AutopilotEvent } from "../src/daemon/protocol";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("requirements clarifier helpers", () => {
  beforeEach(() => {
    initSchema();
    enableBus();
  });

  it("setActiveQuestionId 写入字段 + emit active-question-changed", () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });

    const events: AutopilotEvent[] = [];
    const handler = (e: AutopilotEvent) => events.push(e);
    onEvent("requirement:active-question-changed", handler);

    setActiveQuestionId("r1", "q1");

    const r = getRequirementById("r1");
    expect(r?.active_question_id).toBe("q1");
    expect(events).toHaveLength(1);
    if (events[0].type === "requirement:active-question-changed") {
      expect(events[0].payload.question_id).toBe("q1");
    }
    offEvent("requirement:active-question-changed", handler);
    disableBus();
  });

  it("setActiveQuestionId(null) 清空字段", () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");
    setActiveQuestionId("r1", null);
    const r = getRequirementById("r1");
    expect(r?.active_question_id).toBeNull();
    disableBus();
  });

  it("finishClarification 把 active question resolve + 设 NULL + 状态 → awaiting_approval", () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");

    finishClarification("r1");

    const r = getRequirementById("r1");
    expect(r?.status).toBe("awaiting_approval");
    expect(r?.active_question_id).toBeNull();
    const q = getQuestionById("q1");
    expect(q?.status).toBe("resolved");
    disableBus();
  });

  it("finishClarification 无 active question 时也能工作（直接进 awaiting_approval）", () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    finishClarification("r1");
    const r = getRequirementById("r1");
    expect(r?.status).toBe("awaiting_approval");
    expect(r?.active_question_id).toBeNull();
    disableBus();
  });
});
