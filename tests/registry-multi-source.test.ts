import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover, listWorkflows, getWorkflow } from "../src/core/registry";
import { createDbWorkflow } from "../src/core/workflows";

describe("registry 多源加载", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let db: Database;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `autopilot-multi-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, "workflows"), { recursive: true });
    prevHome = process.env.AUTOPILOT_HOME;
    process.env.AUTOPILOT_HOME = tmpHome;

    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    _setDbForTest(db);
    _clearRegistry();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = prevHome;
    _setDbForTest(null);
    db.close();
    _clearRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeFileWorkflow(name: string, yaml: string, ts = ""): void {
    const dir = join(tmpHome, "workflows", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.yaml"), yaml);
    if (ts) writeFileSync(join(dir, "workflow.ts"), ts);
  }

  it("仅文件工作流：加载并镜像到 DB", async () => {
    writeFileWorkflow(
      "req_dev",
      `name: req_dev
description: 测试
phases:
  - name: design
    timeout: 60
  - name: develop
    timeout: 60
`,
      `export async function run_design() {}\nexport async function run_develop() {}\n`
    );
    await discover();
    const wfs = listWorkflows();
    expect(wfs.find((w) => w.name === "req_dev")).toBeDefined();
    const rows = db.query<{ name: string; source: string }, []>(
      "SELECT name, source FROM workflows ORDER BY name"
    ).all();
    expect(rows).toEqual([{ name: "req_dev", source: "file" }]);
  });

  it("DB 工作流加载（derives_from 一个 file）", async () => {
    writeFileWorkflow(
      "req_dev",
      `name: req_dev
phases:
  - name: design
    timeout: 60
  - name: develop
    timeout: 60
`,
      `export async function run_design() {}\nexport async function run_develop() {}\n`
    );
    await discover();
    createDbWorkflow({
      name: "req_dev_fast",
      description: "skip review",
      derives_from: "req_dev",
      yaml_content: `name: req_dev_fast
phases:
  - name: design
    timeout: 60
`,
    });
    _clearRegistry();
    await discover();
    const wf = getWorkflow("req_dev_fast");
    expect(wf).not.toBeNull();
    expect(wf!.phases.length).toBe(1);
  });

  it("DB 工作流 yaml 含 base 没有的 phase name → 跳过加载（不影响其他）", async () => {
    writeFileWorkflow(
      "req_dev",
      `name: req_dev
phases:
  - name: design
    timeout: 60
`,
      `export async function run_design() {}\n`
    );
    await discover();
    createDbWorkflow({
      name: "wf_bad",
      description: "",
      derives_from: "req_dev",
      yaml_content: `name: wf_bad
phases:
  - name: design
  - name: nonexistent_phase
`,
    });
    _clearRegistry();
    await discover();
    expect(getWorkflow("wf_bad")).toBeNull();
    expect(getWorkflow("req_dev")).not.toBeNull();
  });

  it("DB 工作流 derives_from 不存在的 base → 跳过加载", async () => {
    const ts = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?, ?)",
      ["wf_orphan", "", "name: wf_orphan\nphases: []\n", "no_such_base", ts, ts]
    );
    await discover();
    expect(getWorkflow("wf_orphan")).toBeNull();
  });

  it("文件被删除：再次 discover 时 DB 同步删除", async () => {
    writeFileWorkflow(
      "req_dev",
      `name: req_dev
phases:
  - name: design
    timeout: 60
`,
      `export async function run_design() {}\n`
    );
    await discover();
    expect(getWorkflow("req_dev")).not.toBeNull();

    rmSync(join(tmpHome, "workflows", "req_dev"), { recursive: true });
    _clearRegistry();
    await discover();
    expect(getWorkflow("req_dev")).toBeNull();
    const rows = db.query<{ name: string }, []>(
      "SELECT name FROM workflows"
    ).all();
    expect(rows.length).toBe(0);
  });
});
