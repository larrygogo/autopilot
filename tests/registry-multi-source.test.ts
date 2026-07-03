import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover, listWorkflows, getWorkflow, getWorkflowGitRequirement } from "../src/core/workflow/registry";
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

  it("file 工作流目录被无视：discover 后 registry 里不存在（file 轨已退役）", async () => {
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
    // file 轨退役：目录无视，注册表里不存在，DB 也没有行
    expect(getWorkflow("req_dev")).toBeNull();
    const rows = db.query<{ name: string; source: string }, []>(
      "SELECT name, source FROM workflows ORDER BY name"
    ).all();
    expect(rows.length).toBe(0);
  });

  it("DB 工作流加载（derives_from 一个 native base）", async () => {
    createNativeDbWorkflow({
      name: "req_dev",
      description: "",
      spec_json: JSON.stringify({
        name: "req_dev",
        phases: [
          { name: "design", timeout: 60, prompt: "做设计" },
          { name: "develop", timeout: 60, prompt: "开发" },
        ],
      }),
    });
    await discover();
    // 直接写 DB 行（derived from native base），绕过 createDbWorkflow 的 file-only 守卫（守卫是旧语义）
    const ts = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, kind, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', 'derived', ?, ?, ?)",
      ["req_dev_fast", "skip review", "name: req_dev_fast\nphases:\n  - name: design\n    timeout: 60\n", "req_dev", ts, ts]
    );
    _clearRegistry();
    await discover();
    const wf = getWorkflow("req_dev_fast");
    expect(wf).not.toBeNull();
    expect(wf!.phases.length).toBe(1);
  });

  it("DB 工作流 yaml 含 base 没有的 phase name → 跳过加载（不影响其他）", async () => {
    createNativeDbWorkflow({
      name: "req_dev",
      description: "",
      spec_json: JSON.stringify({
        name: "req_dev",
        phases: [{ name: "design", timeout: 60, prompt: "做设计" }],
      }),
    });
    await discover();
    // 直接写 DB 行（derived from native base），绕过 createDbWorkflow 的 file-only 守卫
    const ts = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, kind, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', 'derived', ?, ?, ?)",
      ["wf_bad", "", "name: wf_bad\nphases:\n  - name: design\n  - name: nonexistent_phase\n", "req_dev", ts, ts]
    );
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

  it("native DB 工作流删除后 discover → 不再注册（DB 行已删）", async () => {
    createNativeDbWorkflow({
      name: "req_dev",
      description: "",
      spec_json: JSON.stringify({
        name: "req_dev",
        phases: [{ name: "design", timeout: 60, prompt: "做设计" }],
      }),
    });
    await discover();
    expect(getWorkflow("req_dev")).not.toBeNull();

    // 删除 DB 行
    db.run("DELETE FROM workflows WHERE name = 'req_dev'");
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
    createNativeDbWorkflow({
      name: "pr_demo",
      description: "",
      spec_json: JSON.stringify({
        name: "pr_demo",
        delivers: "pr",
        sandbox: { git: true },
        phases: [
          { name: "develop", timeout: 60, prompt: "开发" },
          { name: "submit_pr", timeout: 60, deliver: "pr", pr_body_from: "develop" },
        ],
      }),
    });
    await discover();
    const wf = getWorkflow("pr_demo");
    expect(wf).not.toBeNull();
    const ph = wf!.phases.find((p) => !("parallel" in p) && (p as { name: string }).name === "submit_pr") as { func?: unknown } | undefined;
    expect(typeof ph?.func).toBe("function"); // 绑了内置 PR 交付器（无 workflow.ts 也能跑交付）
  });

  // compat：workflow.ts 回退已退役（file 轨退役）。ts 函数不再被加载。测试已移除。

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

  it("H2：克隆 DB-only derived（base 是 native）→ 克隆出 derived 且能注册", async () => {
    // base = native DB 工作流
    createNativeDbWorkflow({
      name: "base_wf",
      description: "",
      spec_json: JSON.stringify({
        name: "base_wf",
        phases: [
          { name: "design", timeout: 60, prompt: "做设计" },
          { name: "develop", timeout: 60, prompt: "开发" },
        ],
      }),
    });
    await discover();
    // derived = DB 行寄生 base（无磁盘目录），直接写 DB 绕过 file-only 守卫
    const ts2 = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, kind, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', 'derived', ?, ?, ?)",
      ["der_src", "", "name: der_src\nphases:\n  - name: design\n    prompt: d2\n", "base_wf", ts2, ts2]
    );
    const { cloneWorkflow } = await import("../src/core/workflow/templates");
    cloneWorkflow("der_src", "der_clone"); // DB 克隆
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

  // delivers 已改为从 phases 派生（2026-06-22 deriveDelivers，取代 validateDeliveryConsistency）：
  // 顶层不再是用户输入，整类「顶层 vs phase 不一致」的拒绝规则退役，改测派生语义。
  it("派生：顶层旧 delivers 与 phase deliver 不一致 → 以 phase 为准覆盖（不再冲突报错）", async () => {
    // spec_json 里留着旧的 delivers:artifacts 但 submit_pr 是 deliver:pr —— 派生取 phase 值
    createNativeDbWorkflow({
      name: "inconsistent",
      description: "",
      spec_json: JSON.stringify({
        name: "inconsistent",
        delivers: "artifacts",
        sandbox: { git: true },
        phases: [
          { name: "develop", prompt: "写" },
          { name: "submit_pr", deliver: "pr" },
        ],
      }),
    });
    await discover();
    expect(getWorkflow("inconsistent")?.delivers).toBe("pr");
  });

  it("派生：有 deliver 阶段但顶层未写 delivers → 自动派生注入", async () => {
    createNativeDbWorkflow({
      name: "no_top",
      description: "",
      spec_json: JSON.stringify({
        name: "no_top",
        sandbox: { git: true },
        phases: [
          { name: "x", prompt: "写" },
          { name: "d", deliver: "pr" },
        ],
      }),
    });
    await discover();
    expect(getWorkflow("no_top")?.delivers).toBe("pr");
  });

  it("派生：无 deliver 阶段但 spec 显式 delivers:artifacts → 回退保留显式（加载成功）", async () => {
    createNativeDbWorkflow({ name: "decl_nodeliver", description: "", spec_json: JSON.stringify({ name: "decl_nodeliver", delivers: "artifacts", phases: [{ name: "produce", prompt: "写" }] }) });
    await discover();
    expect(getWorkflow("decl_nodeliver")?.delivers).toBe("artifacts"); // 派生 null → 回退 yaml/spec 显式值
  });

  // 「非声明式(有 ts) + delivers:pr 放行」：ts 回退已退役（file 轨退役），测试已移除。

  it("交付一致性：native（delivers:pr + deliver:pr 一致）→ 正常加载", async () => {
    createNativeDbWorkflow({
      name: "ok_pr",
      description: "",
      spec_json: JSON.stringify({
        name: "ok_pr",
        delivers: "pr",
        sandbox: { git: true },
        phases: [
          { name: "develop", prompt: "写" },
          { name: "submit_pr", deliver: "pr" },
        ],
      }),
    });
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

  it("DB native 加载也归一 requires.git（删废弃 optional，与 file-load 路径一致）", async () => {
    // 改造前 import 的含 optional 的 spec_json（normalizeSpecDoc 不碰 requires，optional 幸存到 DB 行）；
    // composeNativeDbWorkflow 现在跑 normalizeDeclarations 归一（2026-06-22 二态化补口，对抗审查发现的缺口）。
    createNativeDbWorkflow({
      name: "nat_opt",
      description: "",
      spec_json: JSON.stringify({ name: "nat_opt", requires: { git: "optional" }, sandbox: { git: false }, phases: [{ name: "a", prompt: "x" }] }),
    });
    _clearRegistry();
    await discover();
    const wf = getWorkflow("nat_opt")!;
    expect(wf).not.toBeNull();
    expect(wf.requires?.git).toBeUndefined(); // optional 被 normalizeDeclarations 删（二态化）
    expect(getWorkflowGitRequirement(wf)).toBe(false); // 回退派生自 sandbox.git=false
  });

  it("L6：with_human 已声明式化（最后一个含 ts 的模板去 ts）→ 正常种入 DB", async () => {
    const { seedTemplateWorkflow } = await import("../src/core/workflow/templates");
    expect(seedTemplateWorkflow("with_human")).toBe("seeded");
    const row = getWorkflowFromDb("with_human");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("template");
  });

  it("L6b：含 workflow.ts 的模板 → seedTemplateWorkflow 拒种（has-ts，避免幽灵死行）", async () => {
    // examples 里已无含 ts 的真实模板（with_human 是最后一个），用临时合成 fixture 覆盖守卫
    const { seedTemplateWorkflow } = await import("../src/core/workflow/templates");
    const { mkdirSync, writeFileSync, rmSync, existsSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const fixDir = join(repoRoot, "examples", "workflows", "__ts_fixture");
    try {
      mkdirSync(fixDir, { recursive: true });
      writeFileSync(join(fixDir, "workflow.yaml"), "name: __ts_fixture\nphases:\n  - name: a\n    prompt: x\n");
      writeFileSync(join(fixDir, "workflow.ts"), "export function run_a() {}\n");
      expect(seedTemplateWorkflow("__ts_fixture")).toBe("has-ts");
      expect(getWorkflowFromDb("__ts_fixture")).toBeNull(); // 没种进 DB
    } finally {
      if (existsSync(fixDir)) rmSync(fixDir, { recursive: true, force: true });
    }
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
