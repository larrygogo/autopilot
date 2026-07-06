/**
 * MirrorPusher 单元测试
 *
 * 验证：
 * 1. start() 通过 deps.onEvent 注册全部 11 个事件
 * 2. dispose() 通过存储的绑定函数正确 offEvent（修复旧实现 .bind() 对象不同的 bug）
 * 3. status-changed 事件正确入队（ensureRegistered + enqueue）
 * 4. pushSnapshot 正确调用 backend.postMirrorSnapshot
 * 5. 无 link 映射时事件被静默忽略
 * 6. ensureRegistered 懒注册（首次事件时从 getRequirement 补注册）
 *
 * 全部使用 mock deps，不依赖全局 event-bus / DB / backend。
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { MirrorPusher } from "../src/daemon/selfhosted-connector/mirror-pusher";
import type { MirrorPusherDeps, RequirementSnapshot } from "../src/daemon/selfhosted-connector/mirror-pusher";
import type { AutopilotEvent } from "../src/core/events";

// ── Mock 工厂 ──────────────────────────────────────────────────────────────

type EventHandlerFn = (e: AutopilotEvent) => void;

/**
 * 收集通过 onEvent 注册的处理器（按 type 分组），并在 offEvent 时从集合里移除。
 * onEvent / offEvent 都注入到 MirrorPusherDeps，确保 dispose() 也走同一 tracker。
 */
function makeOnEventTracker(): {
  onEvent(type: string, handler: EventHandlerFn): void;
  offEvent(type: string, handler: EventHandlerFn): void;
  registeredHandlers: Map<string, Array<EventHandlerFn>>;
  fire(type: string, event: AutopilotEvent): void;
} {
  const registeredHandlers = new Map<string, Array<EventHandlerFn>>();

  return {
    registeredHandlers,
    onEvent(type, handler) {
      if (!registeredHandlers.has(type)) registeredHandlers.set(type, []);
      registeredHandlers.get(type)!.push(handler);
    },
    offEvent(type, handler) {
      const arr = registeredHandlers.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx !== -1) arr.splice(idx, 1);
      }
    },
    fire(type, event) {
      const handlers = registeredHandlers.get(type) ?? [];
      // 浅拷贝，防止 handler 在迭代中修改数组
      for (const h of [...handlers]) h(event);
    },
  };
}

function makeReqSnapshot(id = "req-001", status = "clarifying"): RequirementSnapshot {
  return {
    id,
    title: "测试需求",
    status,
    spec_md: "# 测试",
    status_reason: null,
    source: "reqgenie",
    external_ref: `ext-${id}`,
  };
}

function makeDeps(overrides: Partial<MirrorPusherDeps> = {}): {
  deps: MirrorPusherDeps;
  tracker: ReturnType<typeof makeOnEventTracker>;
  snapshots: unknown[];
  events: unknown[];
} {
  const tracker = makeOnEventTracker();
  const snapshots: unknown[] = [];
  const events: unknown[] = [];

  const deps: MirrorPusherDeps = {
    backend: {
      postMirrorSnapshot: mock(async (snap: unknown) => { snapshots.push(snap); }),
      postMirrorEvents: mock(async (evts: unknown) => { events.push(evts); return { seqGap: false }; }),
    } as unknown as MirrorPusherDeps["backend"],
    getRequirement: mock((_id: string): RequirementSnapshot | null => null),
    listComments: mock((_: string) => []),
    listSubPrs: mock((_: string) => []),
    listPhaseEvents: mock((_: string) => []),
    onEvent: (type, handler) => tracker.onEvent(type, handler),
    offEvent: (type, handler) => tracker.offEvent(type, handler),
    ...overrides,
  };

  return { deps, tracker, snapshots, events };
}

// ── 测试套件 ───────────────────────────────────────────────────────────────

describe("MirrorPusher.start()", () => {
  it("通过 deps.onEvent 注册 11 个事件订阅", () => {
    const { deps, tracker } = makeDeps();
    const pusher = new MirrorPusher(deps);
    pusher.start();

    const expectedTypes = [
      "requirement:status-changed",
      "requirement:questions-updated",
      "requirement:question-resolved",
      "requirement:active-question-changed",
      "requirement:spec-revised",
      "requirement:clarifier-round-update",
      "phase:started",
      "phase:completed",
      "phase:awaiting",
      "phase:error",
      "task:transition",
    ];

    for (const type of expectedTypes) {
      expect(tracker.registeredHandlers.has(type)).toBe(true);
      expect(tracker.registeredHandlers.get(type)!.length).toBeGreaterThan(0);
    }

    pusher.dispose();
  });
});

describe("MirrorPusher.dispose()", () => {
  it("dispose 后 registeredHandlers 被清空（handler 被 offEvent）", () => {
    const { deps, tracker } = makeDeps();
    const pusher = new MirrorPusher(deps);
    pusher.start();

    // 启动后应有注册的 handler
    expect(tracker.registeredHandlers.get("requirement:status-changed")!.length).toBe(1);

    pusher.dispose();

    // offEvent 后 handler 从 registeredHandlers 里移除（tracker.offEvent 模拟了移除）
    expect(tracker.registeredHandlers.get("requirement:status-changed")!.length).toBe(0);
  });

  it("多次 dispose 不抛（幂等）", () => {
    const { deps } = makeDeps();
    const pusher = new MirrorPusher(deps);
    pusher.start();
    expect(() => { pusher.dispose(); pusher.dispose(); }).not.toThrow();
  });
});

describe("MirrorPusher 事件处理 — requirement:status-changed", () => {
  it("有 link 映射时入队 status_changed 事件", async () => {
    const { deps, tracker, events } = makeDeps();
    const pusher = new MirrorPusher(deps);
    pusher.start();

    // 注册 link
    pusher.registerLink({
      reqgenie_req_id: "ext-req-001",
      autopilot_req_id: "req-001",
      assignment_id: "asgn-1",
      mirror_seq: 0,
    });

    // 触发事件
    tracker.fire("requirement:status-changed", {
      type: "requirement:status-changed",
      payload: { id: "req-001", from: "clarifying", to: "queued", reason: null },
    } as AutopilotEvent);

    // 等待防抖 flush（200ms + 余量）
    await new Promise((r) => setTimeout(r, 400));

    expect(events.length).toBeGreaterThan(0);
    const sent = (events[0] as Array<{ type: string; payload: unknown }>);
    expect(sent.some((e) => e.type === "status_changed")).toBe(true);

    pusher.dispose();
  });

  it("无 link 映射（且 getRequirement 不返回 reqgenie 来源）时静默忽略", async () => {
    const { deps, tracker, events } = makeDeps({
      getRequirement: mock(() => null),
    });
    const pusher = new MirrorPusher(deps);
    pusher.start();

    // 不注册任何 link
    tracker.fire("requirement:status-changed", {
      type: "requirement:status-changed",
      payload: { id: "req-999", from: "drafting", to: "clarifying", reason: null },
    } as AutopilotEvent);

    await new Promise((r) => setTimeout(r, 400));

    expect(events.length).toBe(0);

    pusher.dispose();
  });
});

describe("MirrorPusher.pushSnapshot()", () => {
  it("有 link 时调用 backend.postMirrorSnapshot", async () => {
    const reqSnap = makeReqSnapshot("req-001", "queued");
    const { deps, snapshots } = makeDeps({
      getRequirement: mock((id: string) => id === "req-001" ? reqSnap : null),
    });
    const pusher = new MirrorPusher(deps);
    pusher.start();

    pusher.registerLink({
      reqgenie_req_id: "ext-req-001",
      autopilot_req_id: "req-001",
      assignment_id: "asgn-1",
      mirror_seq: 0,
    });

    await pusher.pushSnapshot("req-001");

    expect(snapshots.length).toBe(1);
    const snap = snapshots[0] as { autopilot_req_id: string; mirror_status: string };
    expect(snap.autopilot_req_id).toBe("req-001");
    expect(snap.mirror_status).toBe("queued");

    pusher.dispose();
  });

  it("无 link 时不调用 backend（静默返回）", async () => {
    const { deps, snapshots } = makeDeps();
    const pusher = new MirrorPusher(deps);
    pusher.start();

    await pusher.pushSnapshot("req-nonexist");

    expect(snapshots.length).toBe(0);

    pusher.dispose();
  });
});

describe("MirrorPusher 懒注册（ensureRegistered）", () => {
  it("事件触发时若无 link 但 getRequirement 返回 reqgenie 来源则自动注册并推快照", async () => {
    const reqSnap = makeReqSnapshot("req-lazy", "clarifying");
    const { deps, tracker, snapshots } = makeDeps({
      getRequirement: mock((id: string) => id === "req-lazy" ? reqSnap : null),
    });
    const pusher = new MirrorPusher(deps);
    pusher.start();

    // 不调用 registerLink，触发事件时走 ensureRegistered 懒注册路径
    tracker.fire("requirement:status-changed", {
      type: "requirement:status-changed",
      payload: { id: "req-lazy", from: "drafting", to: "clarifying", reason: null },
    } as AutopilotEvent);

    // 等 snapshot debounce + flush
    await new Promise((r) => setTimeout(r, 600));

    // 懒注册后触发了 pushSnapshot
    expect(snapshots.length).toBeGreaterThan(0);

    pusher.dispose();
  });
});

describe("MirrorPusher.registerTaskRequirement()", () => {
  it("注册 task → requirement 映射后 phase:started 事件能触发快照", async () => {
    const reqSnap = makeReqSnapshot("req-001", "running_develop");
    const { deps, tracker, snapshots } = makeDeps({
      getRequirement: mock((id: string) => id === "req-001" ? reqSnap : null),
    });
    const pusher = new MirrorPusher(deps);
    pusher.start();

    pusher.registerLink({
      reqgenie_req_id: "ext-req-001",
      autopilot_req_id: "req-001",
      assignment_id: "asgn-1",
      mirror_seq: 0,
    });
    pusher.registerTaskRequirement("task-abc", "req-001");

    tracker.fire("phase:started", {
      type: "phase:started",
      payload: { taskId: "task-abc", phase: "develop", label: "开发" },
    } as AutopilotEvent);

    // 等 snapshot debounce（300ms + 余量）
    await new Promise((r) => setTimeout(r, 600));

    expect(snapshots.length).toBeGreaterThan(0);

    pusher.dispose();
  });
});
