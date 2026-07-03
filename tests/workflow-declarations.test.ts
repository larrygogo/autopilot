/**
 * 工作流声明层（v2 R5；2026-06-22 二态化）：
 *   - registry 透传 + 缺省派生（requires.git 缺省 = sandbox.git ?? false）+ 非法形状容错
 *   - requires.git **二态**（需要 / 不需要，optional 第三态废弃）；sandbox.git 从 requires.git 派生
 *   - daemon 枚举语义：resolveWorkflowDecl / validateWorkflowInput 闸门矩阵
 *     （requires.git true/false × 集合空/非空 × 交叉校验 delivers:pr）
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadJsonWorkflow,
  getWorkflowGitRequirement,
  getWorkflowGitSandbox,
  registerBuiltin,
  listWorkflows,
  _clearRegistry,
  type WorkflowDefinition,
} from "../src/core/workflow/registry";
import { resolveWorkflowDecl, validateWorkflowInput } from "../src/daemon/workflow-declarations";

const tmpDirs: string[] = [];

afterEach(() => {
  _clearRegistry();
  for (const d of tmpDirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

async function loadFromSpec(spec: Record<string, unknown>): Promise<WorkflowDefinition | null> {
  const dir = join(tmpdir(), `autopilot-wfdecl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.json"), JSON.stringify(spec, null, 2), "utf-8");
  return await loadJsonWorkflow(dir);
}

function builtin(name: string, extra: Partial<WorkflowDefinition>): WorkflowDefinition {
  const wf: WorkflowDefinition = {
    name,
    phases: [],
    initial_state: "pending_x",
    terminal_states: ["done", "cancelled", "failed"],
    ...extra,
  };
  registerBuiltin(wf);
  return wf;
}

describe("registry 声明层透传与派生", () => {
  it("requires.git 二态原样透传；delivers 不校验枚举值（非标准也保留）", async () => {
    const wf = await loadFromSpec({
      name: "t1",
      requires: { git: false },
      phases: [{ name: "a", prompt: "hi" }],
    });
    expect(wf).not.toBeNull();
    expect(wf!.requires?.git).toBe(false);

    const wf2 = await loadFromSpec({
      name: "t2",
      delivers: "something_else",
      phases: [{ name: "a", prompt: "hi" }],
    });
    expect(wf2!.delivers).toBe("something_else"); // 枚举语义在 daemon，core 不拦
  });

  it("requires.git 缺省派生 = sandbox.git ?? false（老工作流零感知）；显式优先", async () => {
    const gitWf = await loadFromSpec({
      name: "t3",
      sandbox: { git: true },
      phases: [{ name: "a", prompt: "hi" }],
    });
    expect(getWorkflowGitRequirement(gitWf!)).toBe(true);

    const plainWf = await loadFromSpec({
      name: "t4",
      phases: [{ name: "a", prompt: "hi" }],
    });
    expect(getWorkflowGitRequirement(plainWf!)).toBe(false);

    // 显式 requires.git=false 优先于 sandbox.git=true 派生
    const explicitWf = await loadFromSpec({
      name: "t5",
      sandbox: { git: true },
      requires: { git: false },
      phases: [{ name: "a", prompt: "hi" }],
    });
    expect(getWorkflowGitRequirement(explicitWf!)).toBe(false);
  });

  it("非法形状容错：requires 非对象 / requires.git 非法值（含废弃的 optional）/ delivers 非字符串 → 删除回退派生", async () => {
    const wf = await loadFromSpec({
      name: "t6",
      requires: "yes_please",
      delivers: 42,
      phases: [{ name: "a", prompt: "hi" }],
    });
    expect(wf!.requires).toBeUndefined();
    expect(wf!.delivers).toBeUndefined();

    // 任意非 true/false 值（含废弃的 "optional"）都被删 → 回退派生自 sandbox.git
    const wf2 = await loadFromSpec({
      name: "t7",
      sandbox: { git: true },
      requires: { git: "optional" },
      phases: [{ name: "a", prompt: "hi" }],
    });
    expect(wf2!.requires?.git).toBeUndefined();
    expect(getWorkflowGitRequirement(wf2!)).toBe(true); // 回退 sandbox.git 派生
  });

  it("requires.git=true 而 sandbox.git 缺失仍可加载（sandbox.git 现从 requires.git 派生，不存在漏写）", async () => {
    const wf = await loadFromSpec({
      name: "t8",
      requires: { git: true },
      phases: [{ name: "a", prompt: "hi" }],
    });
    expect(wf).not.toBeNull();
    expect(getWorkflowGitRequirement(wf!)).toBe(true);
  });

  it("getWorkflowGitSandbox（建 git 沙盒）从 requires.git 派生；显式 sandbox.git 优先（兼容老工作流）", () => {
    // requires.git=true 无 sandbox.git → 派生 true（需要代码库就一定 clone）
    expect(getWorkflowGitSandbox(builtin("s1", { requires: { git: true } }))).toBe(true);
    // requires.git=false / 都无 → false（不 clone）
    expect(getWorkflowGitSandbox(builtin("s2", { requires: { git: false } }))).toBe(false);
    expect(getWorkflowGitSandbox(builtin("s3", {}))).toBe(false);
    // 显式 sandbox.git 优先（老工作流只写 sandbox.git 的兼容路径）
    expect(getWorkflowGitSandbox(builtin("s4", { sandbox: { git: true } }))).toBe(true);
    expect(getWorkflowGitSandbox(builtin("s5", { requires: { git: true }, sandbox: { git: false } }))).toBe(false);
  });

  it("listWorkflows 暴露 requires_git（含派生）与 delivers", () => {
    builtin("wf_pr_x", { sandbox: { git: true }, delivers: "pr" });
    builtin("wf_art_x", { requires: { git: false }, delivers: "artifacts" });
    const rows = listWorkflows();
    const pr = rows.find((w) => w.name === "wf_pr_x")!;
    const art = rows.find((w) => w.name === "wf_art_x")!;
    expect(pr.requires_git).toBe(true); // 派生自 sandbox.git
    expect(pr.delivers).toBe("pr");
    expect(art.requires_git).toBe(false);
    expect(art.delivers).toBe("artifacts");
  });
});

describe("daemon 闸门矩阵（resolveWorkflowDecl / validateWorkflowInput）", () => {
  it("resolveWorkflowDecl：注册工作流按声明；非法 delivers 归一 auto；未注册保守 requires.git=true", () => {
    builtin("wf_pr", { sandbox: { git: true }, delivers: "pr" });
    builtin("wf_art", { requires: { git: false }, delivers: "artifacts" });
    builtin("wf_weird", { delivers: "email" });

    expect(resolveWorkflowDecl("wf_pr")).toEqual({ name: "wf_pr", requiresGit: true, delivers: "pr", registered: true });
    expect(resolveWorkflowDecl("wf_art")).toEqual({ name: "wf_art", requiresGit: false, delivers: "artifacts", registered: true });
    expect(resolveWorkflowDecl("wf_weird").delivers).toBe("auto");
    expect(resolveWorkflowDecl("wf_weird").requiresGit).toBe(false);

    const missing = resolveWorkflowDecl("nope");
    expect(missing.registered).toBe(false);
    expect(missing.requiresGit).toBe(true);
    expect(resolveWorkflowDecl(null).name).toBe("dev");
    expect(resolveWorkflowDecl("  ").name).toBe("dev");
  });

  it("矩阵：requires.git × 集合空/非空 × 交叉校验（二态）", () => {
    builtin("g_true", { requires: { git: true }, sandbox: { git: true } });
    builtin("g_false_pr", { requires: { git: false }, delivers: "pr" });
    builtin("g_false_art", { requires: { git: false }, delivers: "artifacts" });
    builtin("g_false", { requires: { git: false } });
    builtin("g_false_auto", { requires: { git: false } });

    // 集合非空：全部放行（无论 requires/delivers）
    for (const wf of ["g_true", "g_false_pr", "g_false_art", "g_false", "g_false_auto", "nope"]) {
      expect(validateWorkflowInput(wf, true, { crossCheckDelivers: true })).toBeNull();
      expect(validateWorkflowInput(wf, true)).toBeNull();
    }

    // 集合空 × requires.git=true → 拒
    expect(validateWorkflowInput("g_true", false)).toContain("需要代码库");
    expect(validateWorkflowInput("g_true", false, { crossCheckDelivers: true })).toContain("需要代码库");
    expect(validateWorkflowInput("nope", false)).toContain("需要代码库"); // 未注册保守 true

    // 集合空 × requires.git=false（无交叉）→ 放行
    expect(validateWorkflowInput("g_false_pr", false)).toBeNull();
    expect(validateWorkflowInput("g_false_art", false)).toBeNull();
    expect(validateWorkflowInput("g_false", false)).toBeNull();

    // enqueue 交叉校验：集合空 × delivers:pr → 拒；artifacts / auto → 放行
    expect(validateWorkflowInput("g_false_pr", false, { crossCheckDelivers: true })).toContain("PR 无处可开");
    expect(validateWorkflowInput("g_false_art", false, { crossCheckDelivers: true })).toBeNull();
    expect(validateWorkflowInput("g_false_auto", false, { crossCheckDelivers: true })).toBeNull();
    expect(validateWorkflowInput("g_false", false, { crossCheckDelivers: true })).toBeNull();
  });
});
