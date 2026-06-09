import { describe, it, expect } from "bun:test";
import type { NowActionIntent } from "../src/core/now-types";

// 已知 intent kind 全集（与 now-types.ts NowActionIntent 同步）
const KNOWN_KINDS = new Set([
  "view_task", "view_requirement", "configure_providers",
  "create_project", "add_workspace", "new_requirement",
  "reject_review", "retry_clarify", "dismiss",
]);

// 各 source 的 buildCard 依赖 DB，难直接构造；这里做静态完整性断言：每个 intent kind 都可构造
// 且在已知集合内、样本覆盖全部 kind。运行时各 source 真填 intent 由各 source 测试 + 全量回归兜。
describe("now intent 完整性", () => {
  it("每个 intent kind 可构造且在已知集合内", () => {
    const samples: NowActionIntent[] = [
      { kind: "view_task", taskId: "t1" },
      { kind: "view_requirement", requirementId: "r1" },
      { kind: "configure_providers" },
      { kind: "create_project" },
      { kind: "add_workspace" },
      { kind: "new_requirement" },
      { kind: "reject_review", taskId: "t1" },
      { kind: "retry_clarify", requirementId: "r1" },
      { kind: "dismiss", cardId: "completed:t1" },
    ];
    for (const s of samples) expect(KNOWN_KINDS.has(s.kind)).toBe(true);
    expect(samples.length).toBe(KNOWN_KINDS.size); // 样本覆盖全部 kind
  });
});
