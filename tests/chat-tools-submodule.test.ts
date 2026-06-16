import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { _setDbForTest } from "../src/core/db";
import { createWorkspace } from "../src/core/sandbox/workspaces";
import { createProject } from "../src/core/projects";
import { buildAutopilotTools } from "../src/agents/tools";

describe("chat tool create_requirement_draft 子模块校验", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    migrate021(db);
    migrate024(db);
    migrate033(db);
    _setDbForTest(db);

    createProject({ id: "proj-001", name: "test-proj" });
    createWorkspace({ id: "cb-p1", project_id: "proj-001", alias: "parent1", path: "/tmp/p1", default_branch: "main" });
    createWorkspace({
      id: "cb-c1",
      project_id: "proj-001",
      alias: "child1",
      path: "/tmp/p1/child1",
      default_branch: "main",
      parent_workspace_id: "cb-p1",
      submodule_path: "child1",
    });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirements");
  });

  async function callCreateDraft(repo_alias: string, title: string): Promise<string> {
    const tools = await buildAutopilotTools();
    const tool = tools.find((t) => t.name === "create_requirement_draft");
    if (!tool) throw new Error("tool not found");
    const res = await tool.handler({ repo_alias, title }, undefined as any);
    const first = res.content[0] as { type: string; text?: string };
    if (first.type !== "text" || typeof first.text !== "string") {
      throw new Error("expected text content");
    }
    return first.text;
  }

  it("用父 repo alias 成功创建草稿", async () => {
    const text = await callCreateDraft("parent1", "新需求");
    expect(text).not.toMatch(/^错误：/);
    const obj = JSON.parse(text);
    expect(obj.repo_alias).toBe("parent1");
    expect(obj.status).toBe("drafting");
  });

  it("用子模块 alias 报错并提示用父 repo", async () => {
    const text = await callCreateDraft("child1", "新需求");
    expect(text).toMatch(/^错误：/);
    expect(text).toMatch(/子模块/);
    expect(text).toMatch(/parent1/); // 提示父 repo alias
  });

  it("不存在的 alias 仍按原逻辑报错", async () => {
    const text = await callCreateDraft("no-such", "新需求");
    expect(text).toMatch(/^错误：repo_alias 不存在/);
  });
});
