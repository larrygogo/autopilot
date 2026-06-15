/**
 * 工作流声明层（v2 R5）：
 *   - registry 透传 + 缺省派生（requires.git 缺省 = sandbox.git ?? false）+ 非法形状容错
 *   - lint：requires.git=true 而 sandbox.git 缺失 → warn（不拒载）
 *   - daemon 枚举语义：resolveWorkflowDecl / validateWorkflowInput 闸门矩阵
 *     （requires.git true/optional/false × 集合空/非空 × 交叉校验 delivers:pr）
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadYamlWorkflow,
  getWorkflowGitRequirement,
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

async function loadFromYaml(yaml: string): Promise<WorkflowDefinition | null> {
  const dir = join(tmpdir(), `autopilot-wfdecl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.yaml"), yaml, "utf-8");
  return await loadYamlWorkflow(dir);
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
  it("requires/delivers 原样透传（不校验枚举值——非标准字符串也保留）", async () => {
    const wf = await loadFromYaml([
      "name: t1",
      "requires:",
      "  git: \"optional\"",
      "delivers: artifacts",
      "phases:",
      "  - name: a",
      "    prompt: hi",
    ].join("\n"));
    expect(wf).not.toBeNull();
    expect(wf!.requires?.git).toBe("optional");
    expect(wf!.delivers).toBe("artifacts");

    const wf2 = await loadFromYaml([
      "name: t2",
      "delivers: something_else",
      "phases:",
      "  - name: a",
      "    prompt: hi",
    ].join("\n"));
    expect(wf2!.delivers).toBe("something_else"); // 枚举语义在 daemon，core 不拦
  });

  it("requires.git 缺省派生 = sandbox.git ?? false（老工作流零感知）", async () => {
    const gitWf = await loadFromYaml([
      "name: t3",
      "sandbox:",
      "  git: true",
      "phases:",
      "  - name: a",
      "    prompt: hi",
    ].join("\n"));
    expect(getWorkflowGitRequirement(gitWf!)).toBe(true);

    const plainWf = await loadFromYaml([
      "name: t4",
      "phases:",
      "  - name: a",
      "    prompt: hi",
    ].join("\n"));
    expect(getWorkflowGitRequirement(plainWf!)).toBe(false);

    // 显式声明优先于派生
    const optWf = await loadFromYaml([
      "name: t5",
      "sandbox:",
      "  git: true",
      "requires:",
      "  git: \"optional\"",
      "phases:",
      "  - name: a",
      "    prompt: hi",
    ].join("\n"));
    expect(getWorkflowGitRequirement(optWf!)).toBe("optional");
  });

  it("非法形状容错：requires 非对象 / requires.git 非法值 / delivers 非字符串 → 删除回退派生", async () => {
    const wf = await loadFromYaml([
      "name: t6",
      "requires: yes_please",
      "delivers: 42",
      "phases:",
      "  - name: a",
      "    prompt: hi",
    ].join("\n"));
    expect(wf!.requires).toBeUndefined();
    expect(wf!.delivers).toBeUndefined();

    const wf2 = await loadFromYaml([
      "name: t7",
      "sandbox:",
      "  git: true",
      "requires:",
      "  git: maybe",
      "phases:",
      "  - name: a",
      "    prompt: hi",
    ].join("\n"));
    expect(wf2!.requires?.git).toBeUndefined();
    expect(getWorkflowGitRequirement(wf2!)).toBe(true); // 回退 sandbox.git 派生
  });

  it("lint：requires.git=true 而 sandbox.git 缺失仍可加载（warn 不拒载）", async () => {
    const wf = await loadFromYaml([
      "name: t8",
      "requires:",
      "  git: true",
      "phases:",
      "  - name: a",
      "    prompt: hi",
    ].join("\n"));
    expect(wf).not.toBeNull();
    expect(getWorkflowGitRequirement(wf!)).toBe(true);
  });

  it("listWorkflows 暴露 requires_git（含派生）与 delivers", () => {
    builtin("wf_pr_x", { sandbox: { git: true }, delivers: "pr" });
    builtin("wf_art_x", { requires: { git: "optional" }, delivers: "artifacts", sandbox: { git: true } });
    const rows = listWorkflows();
    const pr = rows.find((w) => w.name === "wf_pr_x")!;
    const art = rows.find((w) => w.name === "wf_art_x")!;
    expect(pr.requires_git).toBe(true);
    expect(pr.delivers).toBe("pr");
    expect(art.requires_git).toBe("optional");
    expect(art.delivers).toBe("artifacts");
  });
});

describe("daemon 闸门矩阵（resolveWorkflowDecl / validateWorkflowInput）", () => {
  it("resolveWorkflowDecl：注册工作流按声明；非法 delivers 归一 auto；未注册保守 requires.git=true", () => {
    builtin("wf_pr", { sandbox: { git: true }, delivers: "pr" });
    builtin("wf_art", { requires: { git: "optional" }, delivers: "artifacts" });
    builtin("wf_weird", { delivers: "email" });

    expect(resolveWorkflowDecl("wf_pr")).toEqual({ name: "wf_pr", requiresGit: true, delivers: "pr", registered: true });
    expect(resolveWorkflowDecl("wf_art")).toEqual({ name: "wf_art", requiresGit: "optional", delivers: "artifacts", registered: true });
    expect(resolveWorkflowDecl("wf_weird").delivers).toBe("auto");
    expect(resolveWorkflowDecl("wf_weird").requiresGit).toBe(false);

    const missing = resolveWorkflowDecl("nope");
    expect(missing.registered).toBe(false);
    expect(missing.requiresGit).toBe(true);
    // null/空 → 默认 dev（此处未注册 → 保守）
    expect(resolveWorkflowDecl(null).name).toBe("dev");
    expect(resolveWorkflowDecl("  ").name).toBe("dev");
  });

  it("矩阵：requires.git × 集合空/非空 × 交叉校验", () => {
    builtin("g_true", { requires: { git: true }, sandbox: { git: true } });
    builtin("g_opt_pr", { requires: { git: "optional" }, delivers: "pr", sandbox: { git: true } });
    builtin("g_opt_art", { requires: { git: "optional" }, delivers: "artifacts", sandbox: { git: true } });
    builtin("g_false", { requires: { git: false } });
    builtin("g_opt_auto", { requires: { git: "optional" } });

    // 集合非空：全部放行（无论 requires/delivers）
    for (const wf of ["g_true", "g_opt_pr", "g_opt_art", "g_false", "g_opt_auto", "nope"]) {
      expect(validateWorkflowInput(wf, true, { crossCheckDelivers: true })).toBeNull();
      expect(validateWorkflowInput(wf, true)).toBeNull();
    }

    // 集合空 × requires.git=true → 拒（clarifying 与 enqueue 同理）
    expect(validateWorkflowInput("g_true", false)).toContain("需要代码库");
    expect(validateWorkflowInput("g_true", false, { crossCheckDelivers: true })).toContain("需要代码库");
    // 未注册保守按 true
    expect(validateWorkflowInput("nope", false)).toContain("需要代码库");

    // 集合空 × optional/false（无交叉）→ 放行（clarifying 闸门）
    expect(validateWorkflowInput("g_opt_pr", false)).toBeNull();
    expect(validateWorkflowInput("g_opt_art", false)).toBeNull();
    expect(validateWorkflowInput("g_false", false)).toBeNull();

    // enqueue 交叉校验：集合空 × delivers:pr → 拒；artifacts / auto → 放行
    expect(validateWorkflowInput("g_opt_pr", false, { crossCheckDelivers: true })).toContain("PR 无处可开");
    expect(validateWorkflowInput("g_opt_art", false, { crossCheckDelivers: true })).toBeNull();
    expect(validateWorkflowInput("g_opt_auto", false, { crossCheckDelivers: true })).toBeNull();
    expect(validateWorkflowInput("g_false", false, { crossCheckDelivers: true })).toBeNull();
  });
});
