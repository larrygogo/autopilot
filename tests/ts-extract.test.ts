import { describe, it, expect } from "bun:test";
import { extractPhaseFunction } from "../src/web/src/lib/ts-extract";

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
