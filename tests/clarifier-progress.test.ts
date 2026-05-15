import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { enableBus, disableBus, onEvent, offEvent } from "../src/core/event-bus";
import type { AutopilotEvent } from "../src/core/events";
import {
  startRound,
  setPhase,
  endRound,
  getRound,
  listAllActive,
  _resetForTest,
  type ClarifierRoundState,
} from "../src/daemon/clarifier-progress";

describe("clarifier-progress: 内存态 + 截断", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("startRound 后 getRound / listAllActive 返回 state，phase=preparing", () => {
    startRound("r1", "");
    const r = getRound("r1");
    expect(r?.req_id).toBe("r1");
    expect(r?.phase).toBe("preparing");
    expect(r?.attempt).toBe(0);
    expect(r?.prompt).toBe("");
    expect(r?.last_parse_error).toBeNull();
    expect(typeof r?.started_at).toBe("number");
    expect(listAllActive()).toHaveLength(1);
  });

  it("endRound('done') 后 getRound 返回 undefined（Map 已删）", () => {
    startRound("r1", "");
    endRound("r1", "done");
    expect(getRound("r1")).toBeUndefined();
    expect(listAllActive()).toHaveLength(0);
  });

  it("endRound 对不存在的 reqId no-op，不抛错", () => {
    expect(() => endRound("nope", "errored")).not.toThrow();
  });

  it("同 reqId 第二次 startRound 覆盖旧 entry，phase 重置 preparing，started_at 更新", async () => {
    startRound("r1", "first");
    const r1 = getRound("r1");
    const t1 = r1!.started_at;

    setPhase("r1", "calling-llm", { attempt: 0, prompt: "P1" });
    expect(getRound("r1")?.phase).toBe("calling-llm");

    // 等一毫秒确保 started_at 不同
    await new Promise(res => setTimeout(res, 2));
    startRound("r1", "second");
    const r2 = getRound("r1");
    expect(r2?.phase).toBe("preparing");
    expect(r2?.prompt).toBe("second");
    expect(r2?.started_at).toBeGreaterThan(t1);
  });

  it("prompt 长度 17000 字符 → 存储 16384 字符 + '…'", () => {
    const long = "a".repeat(17000);
    startRound("r1", long);
    const r = getRound("r1");
    expect(r?.prompt?.length).toBe(16385); // 16384 + '…'
    expect(r?.prompt?.endsWith("…")).toBe(true);
  });

  it("last_parse_error 长度超 16384 → 同样截断", () => {
    startRound("r1", "");
    const long = "x".repeat(17000);
    setPhase("r1", "parsing", { attempt: 1, last_parse_error: long });
    const r = getRound("r1");
    expect(r?.last_parse_error?.length).toBe(16385);
    expect(r?.last_parse_error?.endsWith("…")).toBe(true);
  });

  it("setPhase 不传 patch 仅改 phase 字段，其他字段保留", () => {
    startRound("r1", "p");
    setPhase("r1", "calling-llm", { attempt: 0, prompt: "p" });
    setPhase("r1", "writing");
    const r = getRound("r1");
    expect(r?.phase).toBe("writing");
    expect(r?.prompt).toBe("p");
    expect(r?.attempt).toBe(0);
  });

  it("setPhase 对不存在的 reqId no-op，不创建 entry", () => {
    setPhase("nope", "calling-llm");
    expect(getRound("nope")).toBeUndefined();
  });
});

describe("clarifier-progress: 事件发射", () => {
  beforeEach(() => {
    _resetForTest();
    enableBus();
  });

  afterEach(() => {
    disableBus();
  });

  it("startRound / setPhase / endRound 各 emit 一次 requirement:clarifier-round-update", () => {
    const events: AutopilotEvent[] = [];
    const handler = (e: AutopilotEvent) => events.push(e);
    onEvent("requirement:clarifier-round-update", handler);

    startRound("r1", "");
    setPhase("r1", "calling-llm", { attempt: 0, prompt: "P" });
    endRound("r1", "done");

    offEvent("requirement:clarifier-round-update", handler);

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("requirement:clarifier-round-update");
    if (events[0].type === "requirement:clarifier-round-update") {
      expect(events[0].payload.phase).toBe("preparing");
    }
    if (events[1].type === "requirement:clarifier-round-update") {
      expect(events[1].payload.phase).toBe("calling-llm");
      expect(events[1].payload.prompt).toBe("P");
    }
    if (events[2].type === "requirement:clarifier-round-update") {
      expect(events[2].payload.phase).toBe("done");
    }
  });
});

// ─── runClarifierRound 集成测试 ─────────────────────────────────
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
import {
  createRequirement,
  setRequirementStatus,
  setActiveQuestionId,
} from "../src/core/requirements";
import { createQuestion } from "../src/core/requirement-questions";
import {
  runClarifierRound,
  _setClarifyFnForTest,
  _resetInflightForTest,
} from "../src/daemon/requirement-clarifier";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("clarifier-progress: 集成 runClarifierRound", () => {
  beforeEach(() => {
    initSchema();
    _resetForTest();
    _resetInflightForTest();
    enableBus();
  });

  afterEach(() => {
    _setClarifyFnForTest(null);
    disableBus();
  });

  it("成功路径：preparing → calling-llm(att=0) → writing → done", async () => {
    const phases: string[] = [];
    const handler = (e: AutopilotEvent) => {
      if (e.type === "requirement:clarifier-round-update") {
        phases.push(e.payload.phase);
      }
    };
    onEvent("requirement:clarifier-round-update", handler);

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () =>
      JSON.stringify({
        new_spec_md: "改了",
        summary: "x",
        next_question: { agent_text: "Q1?", suggestions: [] },
        done: false,
      }),
    );

    await runClarifierRound("r1");

    offEvent("requirement:clarifier-round-update", handler);

    expect(phases).toEqual(["preparing", "calling-llm", "writing", "done"]);
    expect(getRound("r1")).toBeUndefined();
  });

  it("parse 第一次失败、第二次成功：preparing → calling-llm(att=0) → parsing → calling-llm(att=1) → writing → done", async () => {
    const updates: { phase: string; attempt: number; last_parse_error: string | null }[] = [];
    const handler = (e: AutopilotEvent) => {
      if (e.type === "requirement:clarifier-round-update") {
        updates.push({
          phase: e.payload.phase,
          attempt: e.payload.attempt,
          last_parse_error: e.payload.last_parse_error,
        });
      }
    };
    onEvent("requirement:clarifier-round-update", handler);

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    let calls = 0;
    _setClarifyFnForTest(async () => {
      calls++;
      return calls === 1
        ? "不是 JSON"
        : JSON.stringify({
            new_spec_md: "改了",
            summary: "x",
            next_question: { agent_text: "Q?", suggestions: [] },
            done: false,
          });
    });

    await runClarifierRound("r1");

    offEvent("requirement:clarifier-round-update", handler);

    const seq = updates.map(u => `${u.phase}/att${u.attempt}`);
    expect(seq).toEqual([
      "preparing/att0",
      "calling-llm/att0",
      "parsing/att1",
      "calling-llm/att1",
      "writing/att1",
      "done/att1",
    ]);
    const parsingUpdate = updates.find(u => u.phase === "parsing");
    expect(parsingUpdate?.last_parse_error).toBeTruthy();
  });

  it("两次都失败：preparing → calling-llm(att=0) → parsing → calling-llm(att=1) → errored", async () => {
    const phases: string[] = [];
    const handler = (e: AutopilotEvent) => {
      if (e.type === "requirement:clarifier-round-update") phases.push(e.payload.phase);
    };
    onEvent("requirement:clarifier-round-update", handler);

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () => "totally not JSON");

    await runClarifierRound("r1");

    offEvent("requirement:clarifier-round-update", handler);

    expect(phases).toEqual([
      "preparing",
      "calling-llm",
      "parsing",
      "calling-llm",
      "errored",
    ]);
    expect(getRound("r1")).toBeUndefined();
  });

  it("active_question_id race 早 abort：preparing → calling-llm → aborted（不写 writing/done）", async () => {
    const phases: string[] = [];
    const handler = (e: AutopilotEvent) => {
      if (e.type === "requirement:clarifier-round-update") phases.push(e.payload.phase);
    };
    onEvent("requirement:clarifier-round-update", handler);

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "qst-pre", requirement_id: "r1", agent_text: "Q?", suggestions: [] });
    setActiveQuestionId("r1", "qst-pre");

    _setClarifyFnForTest(async () => {
      createQuestion({ id: "qst-concurrent", requirement_id: "r1", agent_text: "并发的", suggestions: [] });
      setActiveQuestionId("r1", "qst-concurrent");
      return JSON.stringify({
        new_spec_md: "改了",
        summary: "x",
        next_question: { agent_text: "Q?", suggestions: [] },
        done: false,
      });
    });

    await runClarifierRound("r1");

    offEvent("requirement:clarifier-round-update", handler);

    expect(phases).toEqual(["preparing", "calling-llm", "aborted"]);
    expect(getRound("r1")).toBeUndefined();
  });
});

// ─── requirements.clarifierRound RPC ─────────────────
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

describe("requirements.clarifierRound RPC", () => {
  beforeEach(() => {
    initSchema();
    _resetForTest();
    registerCoreRpcMethods();
  });

  it("当前有 round → ok { round: <state> }", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    startRound("r1", "P");

    const r = await invokeRpcMethod("requirements.clarifierRound", { id: "r1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { round: ClarifierRoundState | null };
      expect(body.round?.req_id).toBe("r1");
      expect(body.round?.phase).toBe("preparing");
      expect(body.round?.prompt).toBe("P");
    }
  });

  it("当前无 round → ok { round: null }", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });

    const r = await invokeRpcMethod("requirements.clarifierRound", { id: "r1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { round: ClarifierRoundState | null };
      expect(body.round).toBeNull();
    }
  });

  it("requirement 不存在 → NOT_FOUND", async () => {
    const r = await invokeRpcMethod("requirements.clarifierRound", { id: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });
});
