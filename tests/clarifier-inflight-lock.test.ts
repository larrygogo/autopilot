/**
 * 用集成测试验证 _inflightRounds 锁是否真的能挡住并发 round。
 *
 * Dogfood 中观察到 daemon 同一进程内 round A（user 答完触发）与 round B
 * （watchdog 触发）相隔 7 秒同时启动，最终产出两个新 question，疑似锁失效。
 * 本测试模拟同样场景：mock LLM 阻塞，在第一个 round 卡在 LLM 期间发起第二
 * 个 trigger，断言：
 *   - 第二个 runClarifierRound 立即返回（被锁拦下）
 *   - LLM 只被调用一次
 *   - 最终只新增一个 question
 */

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
import {
  createRequirement,
  setRequirementStatus,
  setActiveQuestionId,
} from "../src/core/requirements";
import { createQuestion, listQuestionsByRequirement } from "../src/core/requirement-questions";
import { enableBus, disableBus, emit } from "../src/core/event-bus";
import {
  runClarifierRound,
  _setClarifyFnForTest,
  _resetInflightForTest,
  initRequirementClarifier,
  disposeRequirementClarifier,
} from "../src/daemon/requirement-clarifier";
import { resolveQuestion } from "../src/core/requirement-questions";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("_inflightRounds 锁并发拦截", () => {
  beforeEach(() => {
    initSchema();
    _resetInflightForTest();
    enableBus();
    initRequirementClarifier();
  });

  afterEach(() => {
    disposeRequirementClarifier();
    _setClarifyFnForTest(null);
    _resetInflightForTest();
    disableBus();
  });

  it("production 路径：user 答 q → emit question-resolved 触发 round A；watchdog 直接调 runClarifierRound → 锁拦下", async () => {
    // 注意：先 set mock 再 setRequirementStatus(clarifying)，否则后者会 emit
    // status-changed → handler → 用 callClaude 调真实 CLI。
    let llmCallCount = 0;
    let llmResolve: ((s: string) => void) | null = null;
    _setClarifyFnForTest(() =>
      new Promise<string>((res) => {
        llmCallCount++;
        llmResolve = res;
      }),
    );

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "原稿" });
    createQuestion({ id: "qst-pre", requirement_id: "r1", agent_text: "Q0?", suggestions: [] });
    setActiveQuestionId("r1", "qst-pre");
    setRequirementStatus("r1", "clarifying"); // 此处 emit status-changed → handler → round A 启动

    // 等 microtask 把 handler → runClarifierRound → _runClarifierRoundInner sync 链路跑完
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(llmCallCount).toBe(1); // round A 应已启动 + LLM 调一次

    // 此时 _inflightRounds 应有 r1。模拟 watchdog 直接调
    const roundB = runClarifierRound("r1");
    await roundB;
    expect(llmCallCount).toBe(1); // round B 应被锁拦下

    // 释放 round A 的 LLM
    llmResolve!(
      JSON.stringify({
        new_spec_md: "改了",
        summary: "fix",
        next_question: { agent_text: "Q1", suggestions: [] },
        done: false,
      }),
    );
    await new Promise(res => setTimeout(res, 50));

    const qs = listQuestionsByRequirement("r1");
    expect(qs.length).toBe(2);
    expect(llmCallCount).toBe(1);
  });

  it("LLM 卡住期间第二次 trigger → 锁拦下，LLM 只调一次，只产一个新 question", async () => {
    let llmCallCount = 0;
    let llmResolve: ((s: string) => void) | null = null;
    _setClarifyFnForTest(() =>
      new Promise<string>((res) => {
        llmCallCount++;
        llmResolve = res;
      }),
    );

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "原稿" });
    createQuestion({ id: "qst-pre", requirement_id: "r1", agent_text: "Q0?", suggestions: [] });
    setActiveQuestionId("r1", "qst-pre");
    setRequirementStatus("r1", "clarifying");

    // setRequirementStatus 已 emit status-changed → handler → round A 启动
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // round A：handler / user 触发的那一个，LLM 在 mock 里被卡住
    const roundA = Promise.resolve(); // round A 已经由 handler 启动了

    // 等 microtask 把 sync part (_inflightRounds.add) 跑完
    await Promise.resolve();
    await Promise.resolve();

    // 此时 _inflightRounds 应包含 "r1"。再发一次（模拟 watchdog 60s 定时器 fire）
    const roundB = runClarifierRound("r1");
    await roundB; // round B 应当立即返回（锁拦下）

    // round B 走完后 LLM 应该仍只被调一次（round A 的那次还没完）
    expect(llmCallCount).toBe(1);

    // 释放 round A 的 LLM
    llmResolve!(
      JSON.stringify({
        new_spec_md: "改了",
        summary: "fix",
        next_question: { agent_text: "Q1", suggestions: [] },
        done: false,
      }),
    );
    await roundA;

    // 最终：原 qst-pre + round A 写的新 q，共 2 个；round B 没产生 question
    const qs = listQuestionsByRequirement("r1");
    expect(qs.length).toBe(2);
  });
});
