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
import { up as m019 } from "../src/migrations/019-task-requirement-id";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as m012 } from "../src/migrations/012-spec-revisions";
import { up as m013 } from "../src/migrations/013-active-question-id";
import { up as m014 } from "../src/migrations/014-resolve-orphan-open-questions";
import { up as m015 } from "../src/migrations/015-clarifier-error";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m032 } from "../src/migrations/032-requirement-attachments";
import { up as m034 } from "../src/migrations/034-requirement-sessions";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, setRequirementStatus, getRequirementById } from "../src/core/requirements";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";
import { enableBus, disableBus } from "../src/core/event-bus";
import { createDefaultAggregator, type Aggregator } from "../src/core/now-aggregator";
import { setNowAggregator } from "../src/daemon/routes-now";
import { _setClarifyFnForTest, initRequirementClarifier, disposeRequirementClarifier } from "../src/daemon/requirement-clarifier";

describe("clarifier e2e — 完整链路", () => {
  let agg: Aggregator;

  beforeAll(async () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m019, m021, m024, m032, m034].forEach(fn => fn(db));
    _setDbForTest(db);
    registerCoreRpcMethods();
    createProject({ id: "p1", name: "测试项目" });
    enableBus();
    initRequirementClarifier();
    agg = createDefaultAggregator();
    await agg.start();
    setNowAggregator(agg);
  });

  afterAll(() => {
    agg.dispose();
    setNowAggregator(null);
    disposeRequirementClarifier();
    _setClarifyFnForTest(null);
    disableBus();
  });

  it("US-1: 创建需求 → 进 clarifying → AI 提一个问题 → /now 出 1 卡", async () => {
    createRequirement({ id: "e2e-1", project_id: "p1", title: "测试需求", spec_md: "" });

    _setClarifyFnForTest(async (_prompt, _reqId, _sessionRef) => ({
      rawText: JSON.stringify({
        new_spec_md: "# 测试需求\n## 目标\n(待确定)",
        summary: "建立框架",
        next_question: { agent_text: "目标用户是谁？", suggestions: ["开发者", "运维"] },
        done: false,
      }),
      newSessionRef: undefined,
    }));

    setRequirementStatus("e2e-1", "clarifying");
    await new Promise(r => setTimeout(r, 100));

    const req = getRequirementById("e2e-1");
    expect(req?.spec_md).toContain("目标");
    expect(req?.active_question_id).toBeTruthy();

    const cards = agg.getCards();
    const card = cards.find(c => c.id === "open-question:e2e-1");
    expect(card).toBeDefined();
    expect(card?.subtitle).toContain("目标用户是谁");
  });

  it("US-1 续：回答问题 → AI 跑下一轮 → spec_md 变 + 新问题", async () => {
    const req = getRequirementById("e2e-1");
    const activeQid = req?.active_question_id;
    expect(activeQid).toBeTruthy();

    _setClarifyFnForTest(async (_prompt, _reqId, _sessionRef) => ({
      rawText: JSON.stringify({
        new_spec_md: "# 测试需求\n## 目标\n面向开发者\n## 范围\n(待定)",
        summary: "明确了目标用户",
        next_question: { agent_text: "范围有多大？", suggestions: [] },
        done: false,
      }),
      newSessionRef: undefined,
    }));

    const replyR = await invokeRpcMethod("comments.add", {
      requirementId: "e2e-1", kind: "question", parent_id: activeQid, from_role: "user", body: "开发者",
    });
    expect(replyR.ok).toBe(true);

    const resolveR = await invokeRpcMethod("comments.resolve", { id: activeQid });
    expect(resolveR.ok).toBe(true);

    await new Promise(r => setTimeout(r, 100));

    const req2 = getRequirementById("e2e-1");
    expect(req2?.spec_md).toContain("开发者");
    expect(req2?.active_question_id).toBeTruthy();
    expect(req2?.active_question_id).not.toBe(activeQid);
  });

  it("US-4: finish-clarification → 进 awaiting_approval + /now 卡片移除", async () => {
    // 清除注入的 mock，防止 finish-clarification 解除 active question 时触发的
    // question-resolved 事件导致 clarifier 再跑一轮并写入新 active_question_id
    _setClarifyFnForTest(async (_prompt, _reqId, _sessionRef) => ({
      rawText: JSON.stringify({
        new_spec_md: "# 测试需求\n## 目标\n面向开发者\n## 范围\n(待定)",
        summary: null,
        next_question: null,
        done: true,
      }),
      newSessionRef: undefined,
    }));

    const finR = await invokeRpcMethod("requirements.finishClarification", { id: "e2e-1" });
    expect(finR.ok).toBe(true);

    await new Promise(r => setTimeout(r, 50));

    const req = getRequirementById("e2e-1");
    expect(req?.status).toBe("awaiting_approval");
    expect(req?.active_question_id).toBeNull();

    const cards = agg.getCards();
    expect(cards.find(c => c.id === "open-question:e2e-1")).toBeUndefined();
  });

  it("requirements.specRevisions 看修订历史", async () => {
    const r = await invokeRpcMethod("requirements.specRevisions", { id: "e2e-1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { revisions: Array<{ summary: string | null }> };
      expect(body.revisions.length).toBeGreaterThan(0);
    }
  });
});
