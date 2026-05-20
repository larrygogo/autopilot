import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { up as m019 } from "../../src/migrations/019-task-requirement-id";
import { up as m021 } from "../../src/migrations/021-requirement-comments";
import { _setDbForTest } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createRequirement, setRequirementStatus } from "../../src/core/requirements";
import { createAwaitingApprovalSource } from "../../src/core/card-sources/awaiting-approval";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m019, m021].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("CardSource: awaiting-approval", () => {
  beforeEach(() => {
    initSchema();
    createProject({ id: "proj-001", name: "测试项目" });
  });

  it("name = 'awaiting-approval'，subscribes 包含 requirement:status-changed", () => {
    const src = createAwaitingApprovalSource();
    expect(src.name).toBe("awaiting-approval");
    expect(src.subscribes).toContain("requirement:status-changed");
  });

  it("scan 返回所有 status=awaiting_approval 的需求作 P1 决策卡", async () => {
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "改 hover bug", spec_md: "" });
    // drafting → awaiting_approval（直接合法转换）
    setRequirementStatus("REQ-001", "awaiting_approval");

    const src = createAwaitingApprovalSource();
    const cards = await src.scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("awaiting-approval:REQ-001");
    expect(cards[0].priority).toBe("P1");
    expect(cards[0].category).toBe("decision");
    expect(cards[0].title).toContain("改 hover bug");
    expect(cards[0].related).toEqual({ type: "requirement", id: "REQ-001" });
    const primary = cards[0].actions.find(a => a.kind === "primary");
    expect(primary?.href).toBe("/requirements/REQ-001");
  });

  it("scan 跳过非 awaiting_approval 状态的需求", async () => {
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "X", spec_md: "" });
    const src = createAwaitingApprovalSource();
    const cards = await src.scan();
    expect(cards).toHaveLength(0);
  });

  it("onEvent 收到 status-changed 到 awaiting_approval 产出 add delta", async () => {
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "X", spec_md: "" });
    setRequirementStatus("REQ-001", "awaiting_approval");

    const src = createAwaitingApprovalSource();
    const deltas = await src.onEvent({
      type: "requirement:status-changed",
      payload: { id: "REQ-001", from: "drafting", to: "awaiting_approval" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
    if (deltas[0].op === "add") expect(deltas[0].card.id).toBe("awaiting-approval:REQ-001");
  });

  it("onEvent 收到从 awaiting_approval 转走的 status-changed 产出 remove delta", async () => {
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "X", spec_md: "" });
    const src = createAwaitingApprovalSource();
    const deltas = await src.onEvent({
      type: "requirement:status-changed",
      payload: { id: "REQ-001", from: "awaiting_approval", to: "running" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") {
      expect(deltas[0].id).toBe("awaiting-approval:REQ-001");
      expect(deltas[0].reason).toBe("resolved");
    }
  });

  it("onEvent 与其他事件类型时返回空数组", async () => {
    const src = createAwaitingApprovalSource();
    const deltas = await src.onEvent({
      type: "task:created",
      payload: { task: {} as never },
    });
    expect(deltas).toEqual([]);
  });
});
