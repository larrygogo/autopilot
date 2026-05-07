import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover } from "../src/core/registry";
import { buildAutopilotTools } from "../src/agents/tools";

function getText(res: { content: Array<{ type: string; text?: string }> }): string {
  const item = res.content[0] as { type: string; text?: string };
  return item.text ?? "";
}

describe("chat tools 工作流管理（W3）", () => {
  let tmpHome: string;
  let db: Database;

  beforeAll(async () => {
    tmpHome = join(tmpdir(), `autopilot-w3-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, "workflows", "req_dev"), { recursive: true });
    writeFileSync(
      join(tmpHome, "workflows", "req_dev", "workflow.yaml"),
      `name: req_dev\nphases:\n  - name: design\n    timeout: 60\n  - name: develop\n    timeout: 60\n`
    );
    writeFileSync(
      join(tmpHome, "workflows", "req_dev", "workflow.ts"),
      `export async function run_design() {}\nexport async function run_develop() {}\n`
    );
    process.env.AUTOPILOT_HOME = tmpHome;

    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    _setDbForTest(db);
    _clearRegistry();
    await discover();
  });

  afterAll(() => {
    delete process.env.AUTOPILOT_HOME;
    _setDbForTest(null);
    db.close();
    _clearRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    db.run("DELETE FROM workflows WHERE source = 'db'");
    _clearRegistry();
    await discover();
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tools = await buildAutopilotTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    const res = await tool.handler(args, undefined as any);
    return getText(res);
  }

  it("list_workflows 返回 source / derives_from", async () => {
    const text = await callTool("list_workflows", {});
    expect(text).not.toMatch(/^错误/);
    const obj = JSON.parse(text);
    const reqDev = obj.find((w: { name: string }) => w.name === "req_dev");
    expect(reqDev).toBeDefined();
    expect(reqDev.source).toBe("file");
  });

  it("list_phase_functions 返回 base 的 phase name 集合", async () => {
    const text = await callTool("list_phase_functions", { workflow_name: "req_dev" });
    expect(text).not.toMatch(/^错误/);
    const obj = JSON.parse(text);
    expect(obj.phase_functions.sort()).toEqual(["design", "develop"]);
  });

  it("list_phase_functions 不存在的 workflow → 错误", async () => {
    const text = await callTool("list_phase_functions", { workflow_name: "no_such" });
    expect(text).toMatch(/^错误/);
  });

  it("create_db_workflow + update_db_workflow + delete_db_workflow 完整链路", async () => {
    // create
    const created = await callTool("create_db_workflow", {
      name: "req_dev_fast",
      derives_from: "req_dev",
      yaml_content: "name: req_dev_fast\nphases:\n  - name: design\n",
      description: "skip review",
    });
    expect(created).not.toMatch(/^错误/);
    const cObj = JSON.parse(created);
    expect(cObj.name).toBe("req_dev_fast");
    expect(cObj.source).toBe("db");

    // update
    const updated = await callTool("update_db_workflow", {
      name: "req_dev_fast",
      yaml_content: "name: req_dev_fast\nphases:\n  - name: design\n  - name: develop\n",
    });
    expect(updated).not.toMatch(/^错误/);

    // delete
    const deleted = await callTool("delete_db_workflow", { name: "req_dev_fast" });
    expect(deleted).not.toMatch(/^错误/);
  });

  it("create_db_workflow derives_from 不存在 → 错误", async () => {
    const text = await callTool("create_db_workflow", {
      name: "wf_x",
      derives_from: "no_such",
      yaml_content: "x",
    });
    expect(text).toMatch(/^错误/);
    expect(text).toMatch(/不存在/);
  });

  it("update_db_workflow 改 file 工作流 → 错误", async () => {
    const text = await callTool("update_db_workflow", {
      name: "req_dev",
      yaml_content: "x",
    });
    expect(text).toMatch(/^错误/);
    expect(text).toMatch(/file|只读/);
  });

  it("delete_db_workflow 删 file 工作流 → 错误", async () => {
    const text = await callTool("delete_db_workflow", { name: "req_dev" });
    expect(text).toMatch(/^错误/);
    expect(text).toMatch(/file|只读/);
  });
});
