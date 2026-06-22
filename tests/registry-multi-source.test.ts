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
import { createDbWorkflow, createNativeDbWorkflow, updateDbWorkflow, getWorkflowFromDb, deleteDbWorkflow, createTemplateDbWorkflow } from "../src/core/workflow/workflows";

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
delivers: pr
sandbox: { git: true }
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

  it("编辑 native 工作流 yaml → spec_json 同步重派生 → compose 反映改动（不静默丢失）", async () => {
    createNativeDbWorkflow({
      name: "edit_native",
      description: "",
      spec_json: JSON.stringify({ name: "edit_native", phases: [{ name: "a", timeout: 60, prompt: "原始" }] }),
    });
    // 模拟 Web 编辑器保存：改 yaml_content（加一个 phase）
    updateDbWorkflow("edit_native", {
      yaml_content: "name: edit_native\nphases:\n  - name: a\n    timeout: 60\n    prompt: 改后\n  - name: b\n    timeout: 60\n    prompt: 新增\n",
    });
    // spec_json（真相）必须同步更新
    const row = getWorkflowFromDb("edit_native")!;
    const spec = JSON.parse(row.spec_json!);
    expect(spec.phases.length).toBe(2);
    expect(spec.phases[0].prompt).toBe("改后");
    // compose 读 spec_json → 改动生效（不是静默丢失）
    await discover();
    const wf = getWorkflow("edit_native");
    const names = wf!.phases.filter((p) => !("parallel" in p)).map((p) => (p as { name: string }).name);
    expect(names).toEqual(["a", "b"]);
  });

  it("H1：file×db 同名碰撞不株连——磁盘同名副本被忽略，DB 工作流仍注册（不蒸发）", async () => {
    // 造一个 native DB 工作流 myflow
    createNativeDbWorkflow({
      name: "myflow", description: "",
      spec_json: JSON.stringify({ name: "myflow", phases: [{ name: "a", timeout: 60, prompt: "x" }] }),
    });
    // 再造一个磁盘同名 file 副本（模拟 sync/手建撞名）
    writeFileWorkflow("myflow", "name: myflow\nphases:\n  - name: b\n    prompt: y\n");
    // 另造一个无关 native，确认它不被株连
    createNativeDbWorkflow({
      name: "other", description: "",
      spec_json: JSON.stringify({ name: "other", phases: [{ name: "c", timeout: 60, prompt: "z" }] }),
    });
    await discover(); // 旧逻辑：撞名 throw → fallback 只注册 file → myflow/other 蒸发
    // 两个 DB 工作流都还在注册表（不蒸发）
    expect(getWorkflow("other")).not.toBeNull();
    expect(getWorkflow("myflow")).not.toBeNull();
    // myflow 仍是 DB 工作流（磁盘副本被忽略，DB 优先）
    expect(getWorkflowFromDb("myflow")!.source).toBe("db");
  });

  it("H2：克隆 DB 模板（无磁盘目录）→ 回退 DB 克隆出 native，不 404", async () => {
    const { seedTemplateWorkflow, cloneWorkflow } = await import("../src/core/workflow/templates");
    seedTemplateWorkflow("dev"); // dev 成 DB 模板（无磁盘目录）
    cloneWorkflow("dev", "my_dev"); // 旧逻辑：磁盘无 dev → "source workflow not found"
    const row = getWorkflowFromDb("my_dev");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("native"); // 克隆出可编辑的 native
    expect(JSON.parse(row!.spec_json!).name).toBe("my_dev"); // 内层 name 归一
  });

  it("H2：克隆 DB-only derived（无磁盘目录）→ 回退 DB 克隆出 derived 且能注册", async () => {
    // base = file 工作流
    writeFileWorkflow("base_wf", "name: base_wf\nphases:\n  - name: design\n    prompt: d\n  - name: develop\n    prompt: v\n");
    await discover();
    // derived = DB 行寄生 base（无磁盘目录）
    createDbWorkflow({ name: "der_src", description: "", derives_from: "base_wf", yaml_content: "name: der_src\nphases:\n  - name: design\n    prompt: d2\n" });
    const { cloneWorkflow } = await import("../src/core/workflow/templates");
    cloneWorkflow("der_src", "der_clone"); // 磁盘无 der_src → 回退 DB 克隆
    const row = getWorkflowFromDb("der_clone");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("derived");
    expect(row!.derives_from).toBe("base_wf");
    await discover();
    expect(getWorkflow("der_clone")).not.toBeNull(); // 能注册（base 仍在）
  });

  it("M1：import 畸形 spec（空 phases / 阶段名非法 / 重名）→ 拒绝，不写脏行", async () => {
    expect(() => createNativeDbWorkflow({ name: "bad1", description: "", spec_json: JSON.stringify({ phases: [] }) })).toThrow();
    expect(() => createNativeDbWorkflow({ name: "bad2", description: "", spec_json: JSON.stringify({ phases: [{ name: "Bad-Name" }] }) })).toThrow();
    expect(() => createNativeDbWorkflow({ name: "bad3", description: "", spec_json: JSON.stringify({ phases: [{ name: "a", prompt: "x" }, { name: "a", prompt: "y" }] }) })).toThrow();
    // 都没写进 DB
    expect(getWorkflowFromDb("bad1")).toBeNull();
    expect(getWorkflowFromDb("bad2")).toBeNull();
  });

  it("L1/L2：import 归一内层 name + strip notify_func 等函数字段", async () => {
    createNativeDbWorkflow({
      name: "norm_demo", description: "归一",
      // 内层 name 故意写错 + 塞 notify_func 字符串
      spec_json: JSON.stringify({ name: "WRONG", notify_func: "evil", setup_func: "x", phases: [{ name: "a", timeout: 60, prompt: "x" }] }),
    });
    const spec = JSON.parse(getWorkflowFromDb("norm_demo")!.spec_json!);
    expect(spec.name).toBe("norm_demo");   // 内层 name 归一为行 name
    expect(spec.notify_func).toBeUndefined(); // 危险函数字段被 strip
    expect(spec.setup_func).toBeUndefined();
  });

  it("交付一致性：顶层 delivers 与 phase deliver 不一致 → 拒加载（用户改了 delivers 没改 phase）", async () => {
    // 用户场景：把 dev 的 delivers:pr 改成 artifacts 但 submit_pr 还是 deliver:pr
    writeFileWorkflow("inconsistent", "name: inconsistent\ndelivers: artifacts\nsandbox: { git: true }\nphases:\n  - name: develop\n    prompt: 写\n  - name: submit_pr\n    deliver: pr\n");
    await discover();
    expect(getWorkflow("inconsistent")).toBeNull(); // 形态冲突 → 跳过注册
  });

  it("交付一致性：有 deliver 阶段但顶层未声明 delivers → 拒", async () => {
    writeFileWorkflow("no_top", "name: no_top\nsandbox: { git: true }\nphases:\n  - name: x\n    prompt: 写\n  - name: d\n    deliver: pr\n");
    await discover();
    expect(getWorkflow("no_top")).toBeNull();
  });

  it("交付一致性：declarative + delivers:artifacts 但无交付阶段 → 拒", async () => {
    createNativeDbWorkflow({ name: "decl_nodeliver", description: "", spec_json: JSON.stringify({ name: "decl_nodeliver", delivers: "artifacts", phases: [{ name: "produce", prompt: "写" }] }) });
    await discover();
    expect(getWorkflow("decl_nodeliver")).toBeNull(); // 声明式无 ts 兜底 → 必须有 deliver 阶段
  });

  it("交付一致性：非声明式(有 ts) + delivers:pr 无 deliver 阶段 → 放行（ts 可能在交付，如老 dev run_submit_pr）", async () => {
    writeFileWorkflow("ts_deliver", "name: ts_deliver\ndelivers: pr\nsandbox: { git: true }\nphases:\n  - name: develop\n    prompt: 写\n  - name: submit_pr\n", "export async function run_submit_pr() {}\n");
    await discover();
    expect(getWorkflow("ts_deliver")).not.toBeNull(); // 规则④ 对有 ts 的工作流不生效
  });

  it("交付一致性：dev 式（delivers:pr + deliver:pr 一致）→ 正常加载", async () => {
    writeFileWorkflow("ok_pr", "name: ok_pr\ndelivers: pr\nsandbox: { git: true }\nphases:\n  - name: develop\n    prompt: 写\n  - name: submit_pr\n    deliver: pr\n");
    await discover();
    expect(getWorkflow("ok_pr")).not.toBeNull();
  });

  it("L4：kind=template 内置模板禁删（核心流程依赖）；native 可删", async () => {
    createTemplateDbWorkflow({ name: "tmpl_x", description: "", spec_json: JSON.stringify({ name: "tmpl_x", phases: [{ name: "a", prompt: "x" }] }) });
    expect(() => deleteDbWorkflow("tmpl_x")).toThrow(/内置模板/);
    expect(getWorkflowFromDb("tmpl_x")).not.toBeNull(); // 没删掉
    // native 仍可删
    createNativeDbWorkflow({ name: "nat_x", description: "", spec_json: JSON.stringify({ name: "nat_x", phases: [{ name: "a", prompt: "x" }] }) });
    deleteDbWorkflow("nat_x");
    expect(getWorkflowFromDb("nat_x")).toBeNull();
  });

  it("L6：含 workflow.ts 的模板 → seedTemplateWorkflow 拒种（has-ts，避免幽灵死行）", async () => {
    const { seedTemplateWorkflow } = await import("../src/core/workflow/templates");
    // with_human 含 setup_with_human_task（workflow.ts）
    expect(seedTemplateWorkflow("with_human")).toBe("has-ts");
    expect(getWorkflowFromDb("with_human")).toBeNull(); // 没种进 DB
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
