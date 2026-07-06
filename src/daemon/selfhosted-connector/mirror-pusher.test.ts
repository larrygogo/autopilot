/**
 * mirror-pusher.test.ts
 * 单元测试：MirrorPusher 懒注册自愈逻辑（ensureRegistered）。
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { MirrorPusher } from "./mirror-pusher";
import type { MirrorPusherDeps, RequirementSnapshot } from "./mirror-pusher";
import type { SelfhostedBackend } from "./backend";
import type { AutopilotEvent } from "../../core/events";

// ── helpers ──────────────────────────────────────────────────

function makeBackend(): SelfhostedBackend {
  return {
    postMirrorEvents: mock(async () => ({ seqGap: false })),
    postMirrorSnapshot: mock(async () => {}),
  } as unknown as SelfhostedBackend;
}

function makeReqSnapshot(
  id: string,
  source: string | null,
  external_ref: string | null,
): RequirementSnapshot {
  return {
    id,
    title: "Test Req",
    status: "running",
    spec_md: "spec",
    status_reason: null,
    source,
    external_ref,
  };
}

function makePusher(getRequirement: MirrorPusherDeps["getRequirement"]): {
  pusher: MirrorPusher;
  backend: SelfhostedBackend;
} {
  const backend = makeBackend();
  const deps: MirrorPusherDeps = {
    backend,
    getRequirement,
    listComments: () => [],
    listSubPrs: () => [],
    listPhaseEvents: () => [],
  };
  return { pusher: new MirrorPusher(deps), backend };
}

function makeStatusChangedEvent(reqId: string): AutopilotEvent {
  return {
    type: "requirement:status-changed",
    payload: { id: reqId, from: "failed", to: "running", reason: null },
  } as AutopilotEvent;
}

// ── 测试套件 ──────────────────────────────────────────────────

describe("MirrorPusher 懒注册自愈（ensureRegistered）", () => {
  it("未映射的 source=reqgenie 需求收到事件时：自动注册 link 并 fire-and-forget 全量快照，增量事件正常入队", async () => {
    const getReq = mock((_id: string): RequirementSnapshot | null =>
      makeReqSnapshot("req-lazy-001", "reqgenie", "rg-external-001"),
    );
    const { pusher, backend } = makePusher(getReq);

    // 发送 status_changed 事件，此需求未在 _byAutopilotId 中
    pusher.handleStatusChanged(makeStatusChangedEvent("req-lazy-001"));

    // getRequirement 应被调用（懒注册路径）
    expect(getReq.mock.calls.length).toBeGreaterThan(0);

    // pushSnapshot 是 fire-and-forget，等待微任务完成
    await new Promise((r) => setTimeout(r, 50));

    // postMirrorSnapshot 应被调用一次（全量快照重置基线）
    expect((backend.postMirrorSnapshot as ReturnType<typeof mock>).mock.calls.length).toBe(1);

    // 增量事件应经防抖后刷出（等待防抖 + flush）
    await new Promise((r) => setTimeout(r, 300));
    expect((backend.postMirrorEvents as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("非 reqgenie 来源的需求事件不触发注册、不推快照、不入队", async () => {
    const getReq = mock((_id: string): RequirementSnapshot | null =>
      makeReqSnapshot("req-other-002", null, null),
    );
    const { pusher, backend } = makePusher(getReq);

    pusher.handleStatusChanged(makeStatusChangedEvent("req-other-002"));

    await new Promise((r) => setTimeout(r, 300));

    // 不应调用 postMirrorSnapshot 也不应 postMirrorEvents
    expect((backend.postMirrorSnapshot as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect((backend.postMirrorEvents as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it("已映射的需求收到事件时不重复调用 getRequirement 也不重推全量快照", async () => {
    const getReq = mock((_id: string): RequirementSnapshot | null =>
      makeReqSnapshot("req-mapped-003", "reqgenie", "rg-external-003"),
    );
    const { pusher, backend } = makePusher(getReq);

    // 预先手动注册 link
    pusher.registerLink({
      reqgenie_req_id: "rg-external-003",
      autopilot_req_id: "req-mapped-003",
      assignment_id: "assign-001",
      mirror_seq: 5,
    });

    pusher.handleStatusChanged(makeStatusChangedEvent("req-mapped-003"));

    await new Promise((r) => setTimeout(r, 300));

    // getRequirement 不应被调用（已在映射中，走快路径）
    expect(getReq.mock.calls.length).toBe(0);

    // 不应推全量快照（仅增量事件）
    expect((backend.postMirrorSnapshot as ReturnType<typeof mock>).mock.calls.length).toBe(0);

    // 增量事件应正常推出
    expect((backend.postMirrorEvents as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});
