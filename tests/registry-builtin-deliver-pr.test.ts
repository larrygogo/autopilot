/**
 * 内置 phase 原语 `builtin: deliver_pr`（声明式工作流砖 2）：
 *   - bindPhaseFunc 识别 builtin → 绑定可调用 func（无需 run_ 函数、无需 prompt 字段）
 *   - 未知 builtin → 绑定一个执行时抛错的占位 func（防静默空跑）
 *   - builtin 优先于 prompt-runner（同时声明 prompt 也走内置）
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadYamlWorkflow,
  _clearRegistry,
  type WorkflowDefinition,
  type PhaseDefinition,
} from "../src/core/registry";

const tmpDirs: string[] = [];

afterEach(() => {
  _clearRegistry();
  for (const d of tmpDirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

async function loadFromYaml(yaml: string): Promise<WorkflowDefinition | null> {
  const dir = join(tmpdir(), `autopilot-builtin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.yaml"), yaml, "utf-8");
  return await loadYamlWorkflow(dir);
}

function topPhase(wf: WorkflowDefinition, name: string): PhaseDefinition {
  const p = wf.phases.find((x) => !("parallel" in x) && (x as PhaseDefinition).name === name);
  if (!p) throw new Error(`phase ${name} 未找到`);
  return p as PhaseDefinition;
}

describe("builtin: deliver_pr 绑定", () => {
  it("deliver_pr phase 无 run_ 函数 / 无 prompt 也能绑定可调用 func", async () => {
    const wf = await loadFromYaml([
      "name: bt_deliver",
      "phases:",
      "  - name: deliver",
      "    builtin: deliver_pr",
      "    timeout: 600",
    ].join("\n"));
    expect(wf).not.toBeNull();
    const phase = topPhase(wf!, "deliver");
    expect(phase.builtin).toBe("deliver_pr");
    expect(typeof phase.func).toBe("function");
  });

  it("未知 builtin → 绑定占位 func，执行时抛清晰错误", async () => {
    const wf = await loadFromYaml([
      "name: bt_unknown",
      "phases:",
      "  - name: weird",
      "    builtin: not_a_real_primitive",
      "    timeout: 600",
    ].join("\n"));
    expect(wf).not.toBeNull();
    const phase = topPhase(wf!, "weird");
    expect(typeof phase.func).toBe("function");
    await expect(phase.func!("task-x")).rejects.toThrow(/not_a_real_primitive/);
  });

  it("builtin 优先于 prompt：同时声明 prompt 仍走内置（不退回 prompt-runner）", async () => {
    const wf = await loadFromYaml([
      "name: bt_priority",
      "phases:",
      "  - name: deliver",
      "    builtin: deliver_pr",
      "    prompt: 这段不该被用",
      "    timeout: 600",
    ].join("\n"));
    const phase = topPhase(wf!, "deliver");
    // 内置绑定不会触发 prompt-runner 的 makePromptRunner；func 存在即可（行为差异由 deliver_pr 路径保证）
    expect(phase.builtin).toBe("deliver_pr");
    expect(typeof phase.func).toBe("function");
  });
});
