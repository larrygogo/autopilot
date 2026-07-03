/**
 * 并行块的编辑操作目前在前端 PhasePipelineEditor 内（直接操作 phases 数组），
 * 后端 setWorkflowPhases 已支持 parallel 结构，这里只测两件事：
 *
 * 1. 后端 setWorkflowPhases 接受含 parallel 的 phases 数组并能正确保存
 * 2. registry.loadJsonWorkflow 能加载 parallel 块（含 prompt 子项）
 * P1 后：改用 loadJsonWorkflow + workflow.json。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadJsonWorkflow,
  isParallelPhase,
  _clearRegistry,
  type ParallelDefinition,
  type PhaseDefinition,
} from "../src/core/workflow/registry";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-parallel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _clearRegistry();
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("parallel block in yaml", () => {
  it("能加载含 parallel 块的工作流", async () => {
    const wfDir = join(tmpHome, "workflows", "par");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "workflow.json"),
      JSON.stringify({
        name: "par",
        phases: [
          { name: "prepare", prompt: "do prep" },
          {
            parallel: {
              name: "build",
              fail_strategy: "cancel_all",
              phases: [
                { name: "build_a", prompt: "build A" },
                { name: "build_b", prompt: "build B" },
              ],
            },
          },
          { name: "deploy", prompt: "deploy" },
        ],
      }, null, 2),
      "utf-8",
    );

    const wf = await loadJsonWorkflow(wfDir);
    expect(wf).not.toBeNull();
    expect(wf!.phases.length).toBe(3);
    expect(isParallelPhase(wf!.phases[1])).toBe(true);

    const par = (wf!.phases[1] as { parallel: ParallelDefinition }).parallel;
    expect(par.name).toBe("build");
    expect(par.fail_strategy).toBe("cancel_all");
    expect(par.phases.length).toBe(2);
    expect(par.phases[0].name).toBe("build_a");
    // 子节点也用 prompt-runner（无 ts）
    expect(typeof par.phases[0].func).toBe("function");
  });

  it("并行块顶层 fail_strategy 缺省为 cancel_all", async () => {
    const wfDir = join(tmpHome, "workflows", "par2");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "workflow.json"),
      JSON.stringify({
        name: "par2",
        phases: [
          {
            parallel: {
              name: "dual",
              phases: [
                { name: "a", prompt: "a" },
                { name: "b", prompt: "b" },
              ],
            },
          },
        ],
      }, null, 2),
      "utf-8",
    );

    const wf = await loadJsonWorkflow(wfDir);
    const par = (wf!.phases[0] as { parallel: ParallelDefinition }).parallel;
    expect(par.fail_strategy).toBe("cancel_all");
  });

  it("并行块名 + 子节点名同时占用 name 命名空间", async () => {
    const wfDir = join(tmpHome, "workflows", "par3");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "workflow.json"),
      JSON.stringify({
        name: "par3",
        phases: [
          {
            parallel: {
              name: "build",
              phases: [
                { name: "build_a", prompt: "a" },
              ],
            },
          },
        ],
      }, null, 2),
      "utf-8",
    );

    const wf = await loadJsonWorkflow(wfDir);
    const par = (wf!.phases[0] as { parallel: ParallelDefinition }).parallel;
    expect(par.name).toBe("build");
    // 子节点的 pending_state / running_state 都正常推导
    const sub = par.phases[0] as PhaseDefinition;
    expect(sub.pending_state).toBe("pending_build_a");
    expect(sub.running_state).toBe("running_build_a");
  });
});
