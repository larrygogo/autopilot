import { describe, it, expect } from "bun:test";
import { extractPhaseFunction, extractPhaseRunFunction } from "../src/web/src/lib/ts-extract";

describe("extractPhaseFunction", () => {
  it("能切出 export async function 形式", () => {
    const src = `
import { getAgent } from "@autopilot/agents";

export async function design(taskId: string): Promise<void> {
  const agent = getAgent("architect");
  await agent.run("写设计文档");
}

export async function review(taskId: string): Promise<void> {
  await getAgent("reviewer").run("评审");
}
`;
    const got = extractPhaseFunction(src, "design");
    expect(got).toContain("export async function design");
    expect(got).toContain('await agent.run("写设计文档");');
    expect(got).not.toContain("export async function review");
  });

  it("能切出 export function（非 async）形式", () => {
    const src = `
export function noop(_t: string): void {
  return;
}
`;
    const got = extractPhaseFunction(src, "noop");
    expect(got).toContain("export function noop");
    expect(got).toContain("return;");
  });

  it("能切出箭头函数形式 export const x = async (...) => { ... }", () => {
    const src = `
export const handle_it = async (taskId: string): Promise<void> => {
  if (taskId) {
    console.log(taskId);
  }
};
`;
    const got = extractPhaseFunction(src, "handle_it");
    expect(got).toContain("export const handle_it");
    expect(got).toContain("console.log(taskId);");
  });

  it("找不到对应函数时返回 null", () => {
    const src = `export async function design(_t: string): Promise<void> {}`;
    expect(extractPhaseFunction(src, "nonexistent")).toBeNull();
  });

  it("空输入返回 null", () => {
    expect(extractPhaseFunction("", "design")).toBeNull();
    expect(extractPhaseFunction("export async function design() {}", "")).toBeNull();
  });

  it("匹配字面函数名：用裸 phase 名匹配不到 run_<phase> 函数（这是历史 bug 的根因）", () => {
    const src = `export async function run_design(taskId: string): Promise<void> {\n  const x = 1;\n}`;
    // 裸 phase 名「design」匹配不到 run_design —— 调用方必须传完整函数名
    expect(extractPhaseFunction(src, "design")).toBeNull();
    expect(extractPhaseFunction(src, "run_design")).toContain("export async function run_design");
  });

  it("函数体里嵌套 { } 也能正确配对", () => {
    const src = `
export async function complex(t: string): Promise<void> {
  if (t) {
    const o = { a: 1, b: { c: 2 } };
    if (o.a) {
      console.log(o);
    }
  }
}

export async function next(t: string): Promise<void> {}
`;
    const got = extractPhaseFunction(src, "complex");
    expect(got).toContain("export async function complex");
    expect(got).toContain("console.log(o);");
    expect(got).not.toContain("export async function next");
  });
});

describe("extractPhaseRunFunction（封装 run_<phase> 命名约定）", () => {
  const src = `
export async function run_design(taskId: string): Promise<void> {
  const x = 1;
}

export async function run_review(taskId: string): Promise<void> {
  await review();
}
`;

  it("传裸 phase 名即可切出 run_<phase> 函数（修复编辑器看不到脚本的 bug）", () => {
    const got = extractPhaseRunFunction(src, "design");
    expect(got).toContain("export async function run_design");
    expect(got).not.toContain("run_review");
  });

  it("空输入返回 null", () => {
    expect(extractPhaseRunFunction("", "design")).toBeNull();
    expect(extractPhaseRunFunction(src, "")).toBeNull();
  });
});
