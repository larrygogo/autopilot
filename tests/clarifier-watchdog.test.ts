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
import { up as m015 } from "../src/migrations/015-clarifier-error";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m032 } from "../src/migrations/032-requirement-attachments";
import { _setDbForTest, getDb } from "../src/core/db";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  setRequirementStatus,
  setActiveQuestionId,
  getRequirementById,
} from "../src/core/requirements";
import { createQuestion, resolveQuestion } from "../src/core/requirement-questions";
import { enableBus, disableBus } from "../src/core/event-bus";
import { _setClarifyFnForTest } from "../src/daemon/requirement-clarifier";
import { runClarifierWatchdog } from "../src/daemon/clarifier-watchdog";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m021, m024, m032].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("clarifier-watchdog", () => {
  beforeEach(() => {
    initSchema();
    enableBus();
  });
  afterEach(() => {
    _setClarifyFnForTest(null);
    disableBus();
  });

  it("active 指向 resolved 的需求 → 触发 runClarifierRound", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");
    resolveQuestion("q1"); // q1 已 resolved，但 active 仍指向 q1（模拟不一致）

    let invoked = 0;
    _setClarifyFnForTest(async () => {
      invoked++;
      return JSON.stringify({
        new_spec_md: "更新后的 spec",
        summary: "记入答案",
        next_question: { agent_text: "下一题?", suggestions: [] },
        done: false,
      });
    });

    await runClarifierWatchdog();
    await new Promise(r => setTimeout(r, 50));

    expect(invoked).toBe(1);
    const req = getRequirementById("r1");
    expect(req?.active_question_id).not.toBe("q1");
    expect(req?.active_question_id).toBeTruthy();
  });

  it("active=NULL 且 updated_at > 120s 前 → 触发", async () => {
    createRequirement({ id: "r2", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r2", "clarifying");
    // 手动把 updated_at 改成 130 秒前
    getDb().run("UPDATE requirements SET updated_at = ? WHERE id = 'r2'", [Date.now() - 130_000]);

    let invoked = 0;
    _setClarifyFnForTest(async () => {
      invoked++;
      return JSON.stringify({
        new_spec_md: "ok",
        summary: null,
        next_question: { agent_text: "Q1?", suggestions: [] },
        done: false,
      });
    });

    await runClarifierWatchdog();
    await new Promise(r => setTimeout(r, 50));

    expect(invoked).toBe(1);
  });

  it("active=NULL 但 updated_at 不到 120s → 不触发（避免打扰新建/正在跑的）", async () => {
    createRequirement({ id: "r3", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r3", "clarifying");
    // updated_at 刚刚（< 120s 前）

    let invoked = 0;
    _setClarifyFnForTest(async () => { invoked++; return JSON.stringify({ new_spec_md: "", summary: null, next_question: null, done: true }); });

    await runClarifierWatchdog();
    await new Promise(r => setTimeout(r, 50));
    expect(invoked).toBe(0);
  });

  it("已有 clarifier_error 的不重复触发", async () => {
    createRequirement({ id: "r4", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r4", "clarifying");
    // updated_at > 120s 前 + 有错误
    getDb().run(
      "UPDATE requirements SET updated_at = ?, clarifier_error = ? WHERE id = 'r4'",
      [Date.now() - 130_000, "previous failure"],
    );

    let invoked = 0;
    _setClarifyFnForTest(async () => { invoked++; return JSON.stringify({ new_spec_md: "", summary: null, next_question: null, done: true }); });

    await runClarifierWatchdog();
    await new Promise(r => setTimeout(r, 50));
    expect(invoked).toBe(0);
  });

  it("非 clarifying 状态不触发", async () => {
    createRequirement({ id: "r5", project_id: "p1", title: "T", spec_md: "" });
    // 默认 drafting，不切到 clarifying
    getDb().run("UPDATE requirements SET updated_at = ? WHERE id = 'r5'", [Date.now() - 130_000]);

    let invoked = 0;
    _setClarifyFnForTest(async () => { invoked++; return JSON.stringify({ new_spec_md: "", summary: null, next_question: null, done: true }); });

    await runClarifierWatchdog();
    await new Promise(r => setTimeout(r, 50));
    expect(invoked).toBe(0);
  });
});
