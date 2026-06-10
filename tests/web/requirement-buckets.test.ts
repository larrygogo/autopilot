import { describe, it, expect } from "bun:test";
import { requirementTab } from "../../src/web/src/lib/requirement-buckets";

describe("requirementTab", () => {
  it("等待人工：clarifying", () => expect(requirementTab("clarifying")).toBe("human"));
  it("等待人工：awaiting_approval", () => expect(requirementTab("awaiting_approval")).toBe("human"));

  it("运行中：drafting", () => expect(requirementTab("drafting")).toBe("running"));
  it("运行中：queued", () => expect(requirementTab("queued")).toBe("running"));
  it("运行中：running", () => expect(requirementTab("running")).toBe("running"));
  it("运行中：awaiting_review", () => expect(requirementTab("awaiting_review")).toBe("running"));
  it("运行中：fix_revision", () => expect(requirementTab("fix_revision")).toBe("running"));
  it("运行中：ready（规约未显式归类，兜底为 running）", () => expect(requirementTab("ready")).toBe("running"));

  it("归档：done", () => expect(requirementTab("done")).toBe("archived"));
  it("归档：cancelled", () => expect(requirementTab("cancelled")).toBe("archived"));
  it("归档：failed", () => expect(requirementTab("failed")).toBe("archived"));

  it("未知状态兜底为 running", () => expect(requirementTab("some_future_status")).toBe("running"));
});
