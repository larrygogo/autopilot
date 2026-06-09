import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { getTaskSandbox, ensureTaskSandbox, resolveSandboxPath, isBenignBranchDeleteError } from "../src/core/sandbox";

describe("isBenignBranchDeleteError（RERUN-07：区分良性 404 vs 真失败）", () => {
  it("404 / 分支不存在 → 良性（幂等成功）", () => {
    expect(isBenignBranchDeleteError("gh: Reference does not exist (HTTP 404)")).toBe(true);
    expect(isBenignBranchDeleteError("HTTP 404: Not Found")).toBe(true);
    expect(isBenignBranchDeleteError("error: no such ref")).toBe(true);
  });
  it("受保护/无凭证/网络 → 真失败（非良性）", () => {
    expect(isBenignBranchDeleteError("HTTP 403: Required status check ... protected branch")).toBe(false);
    expect(isBenignBranchDeleteError("gh: Bad credentials (HTTP 401)")).toBe(false);
    // 网络错（no such host）不能误判成良性 404，否则会让重跑当作分支已删继续 → push 冲突
    expect(isBenignBranchDeleteError("dial tcp: lookup api.github.com: no such host")).toBe(false);
    expect(isBenignBranchDeleteError("connection refused")).toBe(false);
  });
});

// workspace 模块路径：用正斜杠避免 Windows 反斜杠在 JS 字符串字面量里被当作转义字符吃掉
const WORKSPACE_MODULE = join(import.meta.dir, "..", "src", "core", "sandbox").replace(/\\/g, "/");

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
// 但 getTaskSandbox / ensureTaskSandbox 硬编码用 AUTOPILOT_HOME，不方便注入。
// 因此这里用一次性 spawn 子进程跑，避免污染主进程状态 —— 或者用一个更简单的替代：
// 直接跑 getTaskSandbox 只断言结构性（包含 "workspace" 子目录）。

describe("getTaskSandbox 路径结构", () => {
  it("返回形如 <HOME>/runtime/tasks/<id>/workspace", () => {
    const ws = getTaskSandbox("demo-task-001");
    expect(ws).toMatch(/[/\\]runtime[/\\]tasks[/\\]demo-task-001[/\\]workspace$/);
  });

  it("拒绝非法 taskId", () => {
    expect(() => getTaskSandbox("bad id!")).toThrow(/非法/);
  });
});

describe("resolveSandboxPath 路径穿越防护", () => {
  it("合法相对路径返回绝对路径", () => {
    const p = resolveSandboxPath("t1", "src/index.ts");
    expect(p).not.toBeNull();
    expect(p).toMatch(/[/\\]artifacts[/\\]src[/\\]index\.ts$/);
  });

  it("空路径返回 artifacts 根", () => {
    const p = resolveSandboxPath("t1", "");
    expect(p).not.toBeNull();
    // 跨平台：Windows 用反斜杠，Unix 用正斜杠
    expect(p).toMatch(/[/\\]artifacts$/);
  });

  it("拒绝 .. 穿越", () => {
    const p = resolveSandboxPath("t1", "../../../etc/passwd");
    expect(p).toBeNull();
  });

  it("拒绝含 NUL 字符", () => {
    const p = resolveSandboxPath("t1", "foo\0bar");
    expect(p).toBeNull();
  });

  it("根目录开头的 / 被剥离", () => {
    const p = resolveSandboxPath("t1", "/absolute/looking");
    expect(p).not.toBeNull();
    expect(p).toMatch(/[/\\]artifacts[/\\]absolute[/\\]looking$/);
  });
});

describe("ensureTaskSandbox 拷贝 template", () => {
  // 这些用例直接通过子进程跑，确保拿到新的 AUTOPILOT_HOME
  it("能创建空 workspace（无 template）", async () => {
    const script = `
import { ensureTaskSandbox } from "${WORKSPACE_MODULE}";
import { existsSync } from "fs";
const ws = ensureTaskSandbox("t001", "wf_a");
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
import { ensureTaskSandbox } from "${WORKSPACE_MODULE}";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
const ws = ensureTaskSandbox("t002", "wf_b", { template: "workspace_template" });
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
import { ensureTaskSandbox } from "${WORKSPACE_MODULE}";
import { readdirSync } from "fs";
const ws = ensureTaskSandbox("t003", "wf_c", { template: "../../../etc" });
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
