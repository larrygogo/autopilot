import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover, listWorkflows, getWorkflow } from "../src/core/workflow/registry";
import { createDbWorkflow, createNativeDbWorkflow } from "../src/core/workflow/workflows";

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
    migrate048(db);
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

  it("native DB 工作流：从 spec_json 独立组装注册（无寄生 base、无 file）", async () => {
    createNativeDbWorkflow({
      name: "native_demo",
      description: "纯声明式 native 工作流",
      spec_json: JSON.stringify({
        name: "native_demo",
        label: "演示",
        phases: [
          { name: "design", timeout: 60, prompt: "做设计" },
          { name: "review", timeout: 60, prompt: "评审", reject: "design" },
        ],
      }),
    });
    await discover();
    const wf = getWorkflow("native_demo");
    expect(wf).not.toBeNull();
    expect(wf!.phases.length).toBe(2);
    // 状态机自动推导：initial_state = 第一个 phase 的 pending_state
    expect(wf!.initial_state).toBe("pending_design");
    expect(wf!.terminal_states).toContain("done");
    // 行 kind=native、spec_json 落库、yaml_content 是投影
    const row = db.query<{ kind: string; spec_json: string | null; yaml_content: string }, []>(
      "SELECT kind, spec_json, yaml_content FROM workflows WHERE name = 'native_demo'"
    ).get()!;
    expect(row.kind).toBe("native");
    expect(JSON.parse(row.spec_json!).name).toBe("native_demo");
    expect(row.yaml_content).toContain("design"); // yaml 投影非空
  });

  it("native 工作流声明式强制：phase 既无 prompt 又无 gate（需 ts）→ 组装失败、不注册", async () => {
    createNativeDbWorkflow({
      name: "native_bad",
      description: "",
      spec_json: JSON.stringify({
        name: "native_bad",
        phases: [{ name: "design", timeout: 60 }], // 无 prompt / gate / deliver → 声明式下缺框架原语
      }),
    });
    await discover();
    expect(getWorkflow("native_bad")).toBeNull(); // compose 抛错被捕获、跳过注册
  });

  it("phase 声明 deliver:pr → 绑框架内置 PR 交付器（零 ts，submit_pr 不再需要用户函数）", async () => {
    writeFileWorkflow(
      "pr_demo",
      `name: pr_demo
phases:
  - name: develop
    timeout: 60
    prompt: 开发
  - name: submit_pr
    timeout: 60
    deliver: pr
    pr_body_from: develop
`
    );
    await discover();
    const wf = getWorkflow("pr_demo");
    expect(wf).not.toBeNull();
    const ph = wf!.phases.find((p) => !("parallel" in p) && (p as { name: string }).name === "submit_pr") as { func?: unknown } | undefined;
    expect(typeof ph?.func).toBe("function"); // 绑了内置 PR 交付器（无 workflow.ts 也能跑交付）
  });

  it("compat：phase 无 deliver:pr 但有同名 run_ ts → 回退 ts（老 dev 副本未 sync 不破）", async () => {
    writeFileWorkflow(
      "pr_legacy",
      `name: pr_legacy
phases:
  - name: submit_pr
    timeout: 60
`,
      `export async function run_submit_pr() {}\n`
    );
    await discover();
    const wf = getWorkflow("pr_legacy");
    expect(wf).not.toBeNull();
    const ph = wf!.phases.find((p) => !("parallel" in p) && (p as { name: string }).name === "submit_pr") as { func?: unknown } | undefined;
    expect(typeof ph?.func).toBe("function"); // 回退到 run_submit_pr ts
  });

  it("Step5b：seedTemplateWorkflow 把 dev 种成 DB 模板 → 组装注册等价 file 版（零 ts）", async () => {
    const { seedTemplateWorkflow } = await import("../src/core/workflow/templates");
    expect(seedTemplateWorkflow("dev")).toBe("seeded");
    const row = db.query<{ kind: string; spec_json: string | null }, []>(
      "SELECT kind, spec_json FROM workflows WHERE name='dev'"
    ).get();
    expect(row?.kind).toBe("template");
    await discover();
    const wf = getWorkflow("dev");
    expect(wf).not.toBeNull();
    // 阶段齐全、顺序对
    const names = wf!.phases.filter((p) => !("parallel" in p)).map((p) => (p as { name: string }).name);
    expect(names).toEqual(["design", "review", "develop", "code_review", "submit_pr"]);
    const byName: Record<string, Record<string, unknown>> = {};
    for (const p of wf!.phases) if (!("parallel" in p)) byName[(p as { name: string }).name] = p as Record<string, unknown>;
    // 复杂声明都活过 native compose：reject 语法糖→jump_target、decision、submit_pr 绑 PR 交付器
    expect(byName["review"]["jump_target"]).toBe("design");
    expect((byName["review"]["decision"] as Record<string, unknown>)["mode"]).toBe("tool");
    expect(byName["submit_pr"]["deliver"]).toBe("pr");
    expect(typeof byName["submit_pr"]["func"]).toBe("function"); // 框架内置 PR 交付器
    expect(wf!.initial_state).toBe("pending_design");
  });

  it("Step5b：seedTemplateWorkflow 幂等——磁盘已有 file 副本 → skip（不撞名）", async () => {
    writeFileWorkflow("dev", "name: dev\nphases:\n  - name: x\n    prompt: y\n");
    const { seedTemplateWorkflow } = await import("../src/core/workflow/templates");
    expect(seedTemplateWorkflow("dev")).toBe("exists");
    // 没往 DB 种 template 行
    const row = db.query<{ kind: string }, []>("SELECT kind FROM workflows WHERE name='dev' AND kind='template'").get();
    expect(row).toBeNull();
  });
});
