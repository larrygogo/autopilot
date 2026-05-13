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
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, getRequirementById, setRequirementStatus } from "../src/core/requirements";
import { listSpecRevisionsByRequirement } from "../src/core/spec-revisions";
import { listQuestionsByRequirement } from "../src/core/requirement-questions";
import { enableBus, disableBus } from "../src/daemon/event-bus";
import { runClarifierRound, _setClarifyFnForTest } from "../src/daemon/requirement-clarifier";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "测试项目" });
}

describe("clarifier B 模式 — 单轮逻辑", () => {
  beforeEach(() => {
    initSchema();
    enableBus();
  });

  afterEach(() => {
    _setClarifyFnForTest(null);
    disableBus();
  });

  it("AI 返回 done=false + next_question → 创建 question + 设 active_question_id + 写 spec_revision", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () => JSON.stringify({
      new_spec_md: "改造后的需求\n## 现状\n初稿",
      summary: "结构化为标题 + 章节",
      next_question: { agent_text: "目标用户是谁？", suggestions: ["开发者", "运维"] },
      done: false,
    }));

    await runClarifierRound("r1");

    const req = getRequirementById("r1");
    expect(req?.spec_md).toContain("改造后的需求");
    expect(req?.active_question_id).toBeTruthy();
    expect(req?.status).toBe("clarifying");

    const revs = listSpecRevisionsByRequirement("r1");
    expect(revs).toHaveLength(1);
    expect(revs[0].source).toBe("clarifier");
    expect(revs[0].summary).toBe("结构化为标题 + 章节");

    const qs = listQuestionsByRequirement("r1");
    const active = qs.find(q => q.id === req?.active_question_id);
    expect(active?.agent_text).toBe("目标用户是谁？");
    expect(active?.suggestions).toEqual(["开发者", "运维"]);
  });

  it("AI 返回 done=true → 进 awaiting_approval + active_question_id=null", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "已经够清楚了" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () => JSON.stringify({
      new_spec_md: "已经够清楚了",
      summary: null,
      next_question: null,
      done: true,
    }));

    await runClarifierRound("r1");

    const req = getRequirementById("r1");
    expect(req?.status).toBe("awaiting_approval");
    expect(req?.active_question_id).toBeNull();
  });

  it("new_spec_md 与原 spec_md 相同时不写 revision", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "同样的内容" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () => JSON.stringify({
      new_spec_md: "同样的内容",
      summary: null,
      next_question: { agent_text: "更多细节？", suggestions: [] },
      done: false,
    }));

    await runClarifierRound("r1");

    expect(listSpecRevisionsByRequirement("r1")).toHaveLength(0);
    const req = getRequirementById("r1");
    expect(req?.active_question_id).toBeTruthy();
  });

  it("AI 返回非 JSON → 重试 1 次仍失败 → emit clarifier-error + 不动 spec/不创建 question", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "原稿" });
    setRequirementStatus("r1", "clarifying");
    const originalQuestionCount = listQuestionsByRequirement("r1").length;

    let calls = 0;
    _setClarifyFnForTest(async () => {
      calls++;
      return "这不是 JSON，是一段文本";
    });

    const errors: Array<{ id: string; reason: string }> = [];
    const { onEvent, offEvent } = await import("../src/daemon/event-bus");
    const handler = (e: { type: string; payload: { id: string; reason: string } }) => {
      if (e.type === "requirement:clarifier-error") errors.push(e.payload);
    };
    onEvent("requirement:clarifier-error", handler as never);

    await runClarifierRound("r1");

    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe("r1");

    const req = getRequirementById("r1");
    expect(req?.spec_md).toBe("原稿");
    expect(req?.active_question_id).toBeNull();
    expect(listQuestionsByRequirement("r1").length).toBe(originalQuestionCount);

    offEvent("requirement:clarifier-error", handler as never);
  });

  it("requirement 不存在或状态非 clarifying → no-op（不抛、不调 AI）", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });

    let calls = 0;
    _setClarifyFnForTest(async () => {
      calls++;
      return JSON.stringify({ new_spec_md: "", summary: null, next_question: null, done: true });
    });

    await runClarifierRound("r1");
    expect(calls).toBe(0);

    await runClarifierRound("non-existent-req");
    expect(calls).toBe(0);
  });

  it("AI 返回时状态已变（race）→ 丢弃结果，不写 spec/不创建 question", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "原稿" });
    setRequirementStatus("r1", "clarifying");
    const originalQuestionCount = listQuestionsByRequirement("r1").length;

    // AI 返回前模拟状态切换（mock 内 setRequirementStatus）
    _setClarifyFnForTest(async () => {
      // 在 AI "回复"前把 status 改了
      setRequirementStatus("r1", "awaiting_approval");
      return JSON.stringify({
        new_spec_md: "AI 想改",
        summary: "想加章节",
        next_question: { agent_text: "?", suggestions: [] },
        done: false,
      });
    });

    await runClarifierRound("r1");

    const req = getRequirementById("r1");
    expect(req?.spec_md).toBe("原稿");
    expect(req?.active_question_id).toBeNull();
    expect(req?.status).toBe("awaiting_approval");
    expect(listQuestionsByRequirement("r1").length).toBe(originalQuestionCount);
  });
});
