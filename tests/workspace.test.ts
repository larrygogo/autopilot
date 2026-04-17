import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { getTaskWorkspace, ensureTaskWorkspace } from "../src/core/workspace";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-ws-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  mkdirSync(join(tmpHome, "runtime", "tasks"), { recursive: true });
  process.env.AUTOPILOT_HOME_OVERRIDE = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

// 由于 AUTOPILOT_HOME 在 src/index.ts 启动时被 freeze，这里不能通过 env 注入
// 改为直接测试函数输入输出的纯逻辑（路径 / copy 行为）。
// 但 getTaskWorkspace / ensureTaskWorkspace 硬编码用 AUTOPILOT_HOME，不方便注入。
// 因此这里用一次性 spawn 子进程跑，避免污染主进程状态 —— 或者用一个更简单的替代：
// 直接跑 getTaskWorkspace 只断言结构性（包含 "workspace" 子目录）。

describe("getTaskWorkspace 路径结构", () => {
  it("返回形如 <HOME>/runtime/tasks/<id>/workspace", () => {
    const ws = getTaskWorkspace("demo-task-001");
    expect(ws).toMatch(/[/\\]runtime[/\\]tasks[/\\]demo-task-001[/\\]workspace$/);
  });

  it("拒绝非法 taskId", () => {
    expect(() => getTaskWorkspace("bad id!")).toThrow(/非法/);
  });
});

describe("ensureTaskWorkspace 拷贝 template", () => {
  // 这些用例直接通过子进程跑，确保拿到新的 AUTOPILOT_HOME
  it("能创建空 workspace（无 template）", async () => {
    const script = `
import { ensureTaskWorkspace } from "${join(import.meta.dir, "..", "src", "core", "workspace")}";
import { existsSync } from "fs";
const ws = ensureTaskWorkspace("t001", "wf_a");
console.log(JSON.stringify({ ws, exists: existsSync(ws) }));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const result = JSON.parse(out.trim());
    expect(result.exists).toBe(true);
    expect(result.ws).toContain(join("runtime", "tasks", "t001", "workspace"));
  });

  it("有 template 时复制全部内容", async () => {
    const wfDir = join(tmpHome, "workflows", "wf_b");
    mkdirSync(join(wfDir, "workspace_template", "src"), { recursive: true });
    writeFileSync(join(wfDir, "workspace_template", "README.md"), "# hello");
    writeFileSync(join(wfDir, "workspace_template", "src", "index.ts"), "export {}");

    const script = `
import { ensureTaskWorkspace } from "${join(import.meta.dir, "..", "src", "core", "workspace")}";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
const ws = ensureTaskWorkspace("t002", "wf_b", { template: "workspace_template" });
console.log(JSON.stringify({
  readme: readFileSync(join(ws, "README.md"), "utf-8"),
  hasIndex: existsSync(join(ws, "src", "index.ts")),
}));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const result = JSON.parse(out.trim());
    expect(result.readme).toBe("# hello");
    expect(result.hasIndex).toBe(true);
  });

  it("拒绝 template 路径穿越", async () => {
    const script = `
import { ensureTaskWorkspace } from "${join(import.meta.dir, "..", "src", "core", "workspace")}";
import { readdirSync } from "fs";
const ws = ensureTaskWorkspace("t003", "wf_c", { template: "../../../etc" });
console.log(JSON.stringify({ empty: readdirSync(ws).length === 0 }));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const result = JSON.parse(out.trim());
    // workspace 仍然空（template 被拒绝）
    expect(result.empty).toBe(true);
  });
});
