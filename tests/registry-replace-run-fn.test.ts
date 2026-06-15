import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { replaceRunFunction } from "../src/core/workflow/ts-authoring";

let tmpHome: string;
let wfDir: string;
let tsPath: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-replfn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  wfDir = join(tmpHome, "workflows", "wf1");
  mkdirSync(wfDir, { recursive: true });
  tsPath = join(wfDir, "workflow.ts");
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("replaceRunFunction", () => {
  it("能精确替换已存在的 run_<phase> 函数体，不影响其它函数", () => {
    const original = `import { x } from "y";

export async function run_design(taskId: string): Promise<void> {
  // OLD body
  console.log("old design");
}

export async function run_review(taskId: string): Promise<void> {
  console.log("review");
}
`;
    writeFileSync(tsPath, original, "utf-8");

    const newCode = `export async function run_design(taskId: string): Promise<void> {
  // NEW body
  await fetch("/new");
}`;
    const r = replaceRunFunction("wf1", "design", newCode);
    expect(r.mode).toBe("replaced");

    const got = readFileSync(tsPath, "utf-8");
    expect(got).toContain("NEW body");
    expect(got).not.toContain("OLD body");
    expect(got).toContain("export async function run_review");
    // 备份生成
    expect(existsSync(tsPath + ".bak")).toBe(true);
  });

  it("旧函数不存在 → 追加到文件末尾，mode=appended", () => {
    writeFileSync(tsPath, `// header only\n`, "utf-8");
    const newCode = `export async function run_brandnew(_t: string): Promise<void> {}`;
    const r = replaceRunFunction("wf1", "brandnew", newCode);
    expect(r.mode).toBe("appended");
    expect(readFileSync(tsPath, "utf-8")).toContain("run_brandnew");
  });

  it("代码不以 export async function run_<phase>( 开头 → 抛错", () => {
    writeFileSync(tsPath, "", "utf-8");
    expect(() => replaceRunFunction("wf1", "design", "console.log('x');")).toThrow(
      /必须以.*run_design.*开头/,
    );
  });

  it("代码改了函数名 → 抛错（防止 mismatch）", () => {
    writeFileSync(tsPath, "", "utf-8");
    const wrong = `export async function run_other(_t: string): Promise<void> {}`;
    expect(() => replaceRunFunction("wf1", "design", wrong)).toThrow(/run_design/);
  });

  it("phase 名非法 → 抛错", () => {
    expect(() => replaceRunFunction("wf1", "Bad-Name", "x")).toThrow(/非法 phase 名/);
  });

  it("workflow.ts 不存在 → 抛错", () => {
    const valid = `export async function run_design(_t: string): Promise<void> {}`;
    expect(() => replaceRunFunction("wf-missing", "design", valid)).toThrow(/不存在|workflow\.ts/);
  });

  it("函数体含字符串字面量里的 } 也能正确定位结束", () => {
    const original = `export async function run_design(t: string): Promise<void> {
  const s = "a } b } c";
  const o = { nested: { deep: 1 } };
  console.log(s, o);
}

export async function run_after(t: string): Promise<void> {
  return;
}
`;
    writeFileSync(tsPath, original, "utf-8");
    const newCode = `export async function run_design(t: string): Promise<void> { /* new */ }`;
    replaceRunFunction("wf1", "design", newCode);
    const got = readFileSync(tsPath, "utf-8");
    expect(got).toContain("/* new */");
    expect(got).toContain("export async function run_after");
    // 原 run_after 没被破坏
    expect(got).toMatch(/run_after\(t: string\): Promise<void> \{\s*return;/);
  });
});
