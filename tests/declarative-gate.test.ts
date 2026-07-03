/**
 * 声明式安全闸门（声明式工作流砖 3 / spec 2026-06-14）：
 *   declarative: true → 加载期硬拒任何用户 TS 代码；phase 只能用框架内置原语
 *   （prompt / builtin / gate / parallel）。保证可安全跨人运行别人写的工作流。
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadYamlWorkflow, _clearRegistry } from "../src/core/workflow/registry";

const tmpDirs: string[] = [];

afterEach(() => {
  _clearRegistry();
  for (const d of tmpDirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function makeWf(yaml: string, ts?: string): string {
  const dir = join(tmpdir(), `autopilot-decl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.yaml"), yaml, "utf-8");
  if (ts !== undefined) writeFileSync(join(dir, "workflow.ts"), ts, "utf-8");
  return dir;
}

describe("declarative 安全闸门", () => {
  it("declarative:true + workflow.ts 含 run_ 函数 → ts 被忽略（warn），工作流仍正常加载", async () => {
    const dir = makeWf(
      ["name: decl_ok_ts", "declarative: true", "phases:", "  - name: design", "    prompt: 做设计"].join("\n"),
      "export async function run_design(_t: string): Promise<void> {}\n",
    );
    const wf = await loadYamlWorkflow(dir);
    expect(wf).not.toBeNull(); // ts 被忽略，工作流仍然加载成功
    expect(wf!.phases.length).toBe(1);
  });

  it("declarative:true + 纯 prompt phase（无 ts）→ 正常加载", async () => {
    const dir = makeWf(
      ["name: decl_prompt", "declarative: true", "phases:", "  - name: design", "    prompt: 做设计"].join("\n"),
    );
    const wf = await loadYamlWorkflow(dir);
    expect(wf).not.toBeNull();
    expect(wf!.declarative).toBe(true);
  });

  it("declarative:true + phase 既无 prompt 也无 gate → 报错（缺框架原语）", async () => {
    const dir = makeWf(
      ["name: decl_empty", "declarative: true", "phases:", "  - name: design", "    timeout: 600"].join("\n"),
    );
    await expect(loadYamlWorkflow(dir)).rejects.toThrow(/缺少框架原语|不能用 run_/);
  });

  it("declarative:true + 纯 gate 关卡（无 prompt）→ 正常加载（人工检查点）", async () => {
    const dir = makeWf(
      [
        "name: decl_gate",
        "declarative: true",
        "phases:",
        "  - name: build",
        "    prompt: 实现",
        "  - name: approve",
        "    gate: true",
      ].join("\n"),
    );
    const wf = await loadYamlWorkflow(dir);
    expect(wf).not.toBeNull();
  });

  it("非 declarative + run_ 函数 → 不受闸门影响（正常绑定）", async () => {
    const dir = makeWf(
      ["name: plain_ts", "phases:", "  - name: design", "    timeout: 600"].join("\n"),
      "export async function run_design(_t: string): Promise<void> {}\n",
    );
    const wf = await loadYamlWorkflow(dir);
    expect(wf).not.toBeNull();
    const design = wf!.phases.find((p) => !("parallel" in p)) as { func?: unknown };
    expect(typeof design.func).toBe("function");
  });
});
