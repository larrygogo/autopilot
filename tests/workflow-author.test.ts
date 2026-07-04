import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { runWorkflowAuthor, saveAuthoredWorkflow, _setAuthorFnForTest } from "../src/daemon/workflow-author";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m048 } from "../src/migrations/048-workflow-kind-spec-json";
import { _setDbForTest } from "../src/core/db";
import { getWorkflowFromDb } from "../src/core/workflow/workflows";

let tmpHome: string;
let db: Database;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-author-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  m001(db); m007(db); m048(db);
  _setDbForTest(db);
});

afterEach(() => {
  _setAuthorFnForTest(null);
  _setDbForTest(null);
  db.close();
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("runWorkflowAuthor（声明式，JSON spec）", () => {
  it("工具捕获形状 {name, description, spec} → 返回 name + spec_json（无 ts/yaml 字段）", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "my_dev",
        description: "测试用",
        spec: {
          name: "my_dev",
          description: "测试用",
          phases: [{ name: "design", prompt: "做设计 ${REQUIREMENT}" }],
        },
      }),
    );
    const r = await runWorkflowAuthor({ description: "做一个简单工作流" });
    expect(r.name).toBe("my_dev");
    const spec = JSON.parse(r.spec_json) as { phases: Array<{ name: string }> };
    expect(spec.phases[0].name).toBe("design");
    expect((r as unknown as Record<string, unknown>).ts).toBeUndefined(); // 不再有 ts
    expect((r as unknown as Record<string, unknown>).yaml).toBeUndefined(); // 不再有 yaml
    expect(r.warnings.length).toBe(0);
  });

  it("降级形状（```json 围栏块内直接是 spec doc）→ 剥围栏后接受", async () => {
    _setAuthorFnForTest(async () =>
      "```json\n" +
      JSON.stringify({
        name: "fenced_wf",
        description: "围栏降级",
        phases: [{ name: "draft", prompt: "写 ${REQUIREMENT}" }],
      }) +
      "\n```",
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.name).toBe("fenced_wf");
    expect(JSON.parse(r.spec_json).phases[0].name).toBe("draft");
    expect(r.warnings.length).toBe(0);
  });

  it("裸 spec doc JSON（降级块剥围栏后形状）→ 接受，name/description 从 spec 取", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "bare_spec",
        description: "裸 spec 降级",
        phases: [{ name: "draft", prompt: "写 ${REQUIREMENT}" }],
      }),
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.name).toBe("bare_spec");
    expect(r.description).toBe("裸 spec 降级");
    expect(JSON.parse(r.spec_json).phases[0].name).toBe("draft");
    expect(r.warnings.length).toBe(0);
  });

  it("LLM 抛错走兜底，stub spec_json 带 prompt（声明式可跑）", async () => {
    _setAuthorFnForTest(async () => { throw new Error("provider down"); });
    const r = await runWorkflowAuthor({ description: "做点啥" });
    const spec = JSON.parse(r.spec_json) as { phases: Array<{ prompt?: string }> };
    expect(spec.phases[0].prompt).toBeTruthy();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("AI 返回非法格式走兜底", async () => {
    _setAuthorFnForTest(async () => "not json at all");
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("格式") || w.includes("非法"))).toBe(true);
  });

  it("缺 spec 字段（且顶层无 phases）走兜底", async () => {
    _setAuthorFnForTest(async () => JSON.stringify({ name: "x", description: "x" }));
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("缺 spec"))).toBe(true);
  });

  it("phase 既无 prompt 也无 gate/deliver → warning（声明式跑不起来）", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "x",
        description: "x",
        spec: {
          name: "x",
          phases: [{ name: "design", prompt: "做" }, { name: "review" }],
        },
      }),
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("review"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("design"))).toBe(false);
  });

  it("全 prompt → 无 warning", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "zero_code",
        description: "纯 prompt",
        spec: {
          name: "zero_code",
          phases: [
            { name: "draft", prompt: "写 ${REQUIREMENT}" },
            { name: "polish", prompt: "改进" },
          ],
        },
      }),
    );
    const r = await runWorkflowAuthor({ description: "测试" });
    expect(r.warnings.length).toBe(0);
  });

  it("gate / deliver phase 不报 warning（框架原语可跑）", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "m",
        description: "m",
        spec: {
          name: "m",
          phases: [
            { name: "design", prompt: "设计" },
            { name: "approve", gate: true },
            { name: "submit_pr", deliver: "pr" },
          ],
        },
      }),
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.length).toBe(0);
  });

  it("误生成 func（代码引用）→ warning（声明式不支持）", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "c",
        description: "c",
        spec: {
          name: "c",
          phases: [{ name: "design", prompt: "设计", func: "run_design" }],
        },
      }),
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("func") || w.includes("代码"))).toBe(true);
  });

  it("label 原样保留", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "labeled",
        description: "测试 label",
        spec: {
          name: "labeled",
          label: "完整开发",
          phases: [{ name: "design", label: "设计", prompt: "设计" }],
        },
      }),
    );
    const r = await runWorkflowAuthor({ description: "测试" });
    const spec = JSON.parse(r.spec_json) as { label: string; phases: Array<{ label: string }> };
    expect(spec.label).toBe("完整开发");
    expect(spec.phases[0].label).toBe("设计");
    expect(r.warnings.length).toBe(0);
  });
});

describe("saveAuthoredWorkflow（落 native DB，JSON spec）", () => {
  const specOf = (name: string, phasePrompt = "x"): string =>
    JSON.stringify({ name, description: "d", phases: [{ name: "a", prompt: phasePrompt }] });

  it("落 native DB 工作流（kind=native + spec_json，不写磁盘）", () => {
    saveAuthoredWorkflow("my_wf", specOf("my_wf"));
    const row = getWorkflowFromDb("my_wf");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("native");
    expect(JSON.parse(row!.spec_json!).phases[0].name).toBe("a");
    // 不写磁盘
    expect(existsSync(join(tmpHome, "workflows", "my_wf"))).toBe(false);
  });

  it("名字非法 → 抛错", () => {
    expect(() => saveAuthoredWorkflow("Bad Name!", specOf("x"))).toThrow();
  });

  it("已存在 → 抛错", () => {
    saveAuthoredWorkflow("dup", specOf("dup", "y"));
    expect(() => saveAuthoredWorkflow("dup", specOf("dup", "z"))).toThrow(/已存在|exists/);
  });

  it("缺 phases → 抛错", () => {
    expect(() => saveAuthoredWorkflow("nop", JSON.stringify({ name: "nop", description: "d" }))).toThrow();
  });

  it("非法 JSON（yaml 文本）→ 抛错", () => {
    expect(() => saveAuthoredWorkflow("bad", "name: bad\nphases:\n  - name: a\n")).toThrow(/JSON/);
  });
});
