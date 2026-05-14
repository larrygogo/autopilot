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
