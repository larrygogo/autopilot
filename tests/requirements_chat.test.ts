import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { _setDbForTest, initDb } from "../src/core/db";
import { createRepo } from "../src/core/repos";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import { appendFeedback, listFeedbacks } from "../src/core/requirement-feedbacks";

describe("chat tools 集成（直接走 core 函数验证流程）", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    migrate001(db);
    migrate004(db);
    migrate005(db);
    createRepo({ id: "repo-001", alias: "test-repo", path: "/tmp/x", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  it("完整链路：草稿 → 澄清 → ready → queued", () => {
    // create_requirement_draft 等价
    const id = nextRequirementId();
    createRequirement({ id, repo_id: "repo-001", title: "新需求", spec_md: "" });
    expect(getRequirementById(id)?.status).toBe("drafting");

    // update_requirement_spec 等价：写规约 + 自动转 clarifying
    updateRequirement(id, { spec_md: "## 规约\n详情" });
    setRequirementStatus(id, "clarifying");
    expect(getRequirementById(id)?.status).toBe("clarifying");
    expect(getRequirementById(id)?.spec_md).toContain("详情");

    // mark_requirement_ready
    setRequirementStatus(id, "ready");
    expect(getRequirementById(id)?.status).toBe("ready");

    // enqueue_requirement
    setRequirementStatus(id, "queued");
    expect(getRequirementById(id)?.status).toBe("queued");
  });

  it("inject_feedback 等价：追加 manual 反馈", () => {
    const id = nextRequirementId();
    createRequirement({ id, repo_id: "repo-001", title: "x" });
    appendFeedback({
      requirement_id: id,
      source: "manual",
      body: "请把 X 改成 Y",
    });
    const fbs = listFeedbacks(id);
    expect(fbs.length).toBe(1);
    expect(fbs[0].source).toBe("manual");
  });

  it("cancel_requirement 等价：任意非终态 → cancelled", () => {
    const id = nextRequirementId();
    createRequirement({ id, repo_id: "repo-001", title: "y" });
    setRequirementStatus(id, "cancelled");
    expect(getRequirementById(id)?.status).toBe("cancelled");
  });

  it("buildAutopilotTools 能成功构造 8 个新工具", async () => {
    // 跟其他工具集成的 sanity check
    const { buildAutopilotTools } = await import("../src/agents/tools");
    const tools = await buildAutopilotTools();

    // 探测 tool 对象结构（调试用）
    const sample = tools[0] as unknown as Record<string, unknown>;
    const nameKey = "name" in sample
      ? "name"
      : "inputSchema" in sample
        ? undefined
        : undefined;

    // 兼容两种可能的结构：顶层 name 或 function.name
    function getToolName(t: unknown): string | undefined {
      const obj = t as Record<string, unknown>;
      if (typeof obj["name"] === "string") return obj["name"];
      const fn = obj["function"] as Record<string, unknown> | undefined;
      if (fn && typeof fn["name"] === "string") return fn["name"];
      return undefined;
    }

    const names = tools.map(getToolName).filter(Boolean) as string[];

    for (const want of [
      "list_repos",
      "create_requirement_draft",
      "update_requirement_spec",
      "mark_requirement_ready",
      "enqueue_requirement",
      "list_requirements",
      "inject_feedback",
      "cancel_requirement",
    ]) {
      expect(names).toContain(want);
    }
  });
});
