import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { expandPromptTemplate, tryMakePromptRunnerForPhase, phaseUsesDeliverables } from "../src/core/workflow/prompt-runner";
import { _clearRegistry, loadJsonWorkflow, register, type PhaseDefinition } from "../src/core/workflow/registry";
import { runWithTaskContext } from "../src/core/task/context";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _clearRegistry();
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("expandPromptTemplate", () => {
  const ctx = {
    taskId: "t1",
    phase: "design",
    task: {
      title: "做个登录页",
      requirement: "支持 OAuth + 邮箱",
      repo_path: "/home/user/repos/app",
    },
  };

  it("替换 ${VAR} 形式的内置变量", () => {
    const out = expandPromptTemplate("任务 ${TASK_TITLE} 阶段 ${PHASE}", ctx);
    expect(out).toBe("任务 做个登录页 阶段 design");
  });

  it("替换 $VAR 简写形式", () => {
    const out = expandPromptTemplate("需求：$REQUIREMENT", ctx);
    expect(out).toBe("需求：支持 OAuth + 邮箱");
  });

  it("${TASK.field} 取 task 上 setup_func 留下的字段", () => {
    const out = expandPromptTemplate("仓库：${TASK.repo_path}", ctx);
    expect(out).toBe("仓库：/home/user/repos/app");
  });

  it("未识别的变量原样保留（避免静默失败）", () => {
    const out = expandPromptTemplate("UNKNOWN: ${MYSTERY_VAR}", ctx);
    expect(out).toBe("UNKNOWN: ${MYSTERY_VAR}");
  });

  it("${WORKSPACE} 返回 task 的 workspace 路径（不为空）", () => {
    const out = expandPromptTemplate("ws=${WORKSPACE}", ctx);
    expect(out).toMatch(/ws=.+/);
    expect(out).not.toContain("${WORKSPACE}");
  });
});

// 即焚 sandbox 模型下 ${WORKSPACE} / agent cwd 必须指向 runner 注入的即焚副本，而非旧常驻
// getTaskSandbox 目录（即焚下从不创建）。否则 prompt 模式 agent 在空目录跑 git、改动全丢（EPH-01）。
describe("expandPromptTemplate × 即焚 sandbox 上下文（EPH-01 回归）", () => {
  const baseCtx = {
    taskId: "t1",
    phase: "develop",
    task: { title: "x", requirement: "y" },
  };

  it("phase 在即焚 sandbox 上下文里 → ${WORKSPACE} 取即焚副本目录，而非旧常驻路径", () => {
    const ephemeral = join(tmpHome, "agent-runs", "develop-abc123");
    const out = runWithTaskContext(
      { taskId: "t1", phase: "develop", sandboxDir: ephemeral },
      () => expandPromptTemplate("ws=${WORKSPACE}", baseCtx),
    ) as string;
    expect(out).toBe(`ws=${ephemeral}`);
    expect(out).not.toContain(join("tasks", "t1", "workspace"));
  });

  it("无即焚 sandbox（sandboxDir undefined）→ 回退旧常驻 getTaskSandbox 路径（非 git 工作流不回归）", () => {
    const out = runWithTaskContext(
      { taskId: "t1", phase: "develop", sandboxDir: undefined },
      () => expandPromptTemplate("ws=${WORKSPACE}", baseCtx),
    ) as string;
    expect(out).toContain(join("tasks", "t1", "workspace"));
  });

  it("ctx.workspaceRoot 显式覆盖优先级最高（测试夹具语义不变）", () => {
    const out = runWithTaskContext(
      { taskId: "t1", phase: "develop", sandboxDir: join(tmpHome, "ephemeral") },
      () => expandPromptTemplate("ws=${WORKSPACE}", { ...baseCtx, workspaceRoot: "/override" }),
    ) as string;
    expect(out).toBe("ws=/override");
  });
});

describe("tryMakePromptRunnerForPhase", () => {
  it("phase 有 prompt 字段 → 返回 runner 函数", () => {
    const phase = { name: "design", prompt: "hello" } as unknown as PhaseDefinition;
    const fn = tryMakePromptRunnerForPhase(phase, "wf");
    expect(typeof fn).toBe("function");
  });

  it("phase 没 prompt 字段 → 返回 null", () => {
    const phase = { name: "design" } as unknown as PhaseDefinition;
    expect(tryMakePromptRunnerForPhase(phase, "wf")).toBeNull();
  });

  it("prompt 是空字符串 → 返回 null", () => {
    const phase = { name: "design", prompt: "   " } as unknown as PhaseDefinition;
    expect(tryMakePromptRunnerForPhase(phase, "wf")).toBeNull();
  });
});

describe("loadJsonWorkflow + phase.prompt 集成（P1 后）", () => {
  it("phase 有 prompt + 无 ts run_ 函数 → 自动绑定 prompt-runner", async () => {
    const wfDir = join(tmpHome, "workflows", "promptwf");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "workflow.json"),
      JSON.stringify({
        name: "promptwf",
        phases: [{ name: "do_it", prompt: "用 ${TASK_TITLE} 做一个测试" }],
      }, null, 2),
      "utf-8",
    );

    const wf = await loadJsonWorkflow(wfDir);
    expect(wf).not.toBeNull();
    const phase = wf!.phases[0] as PhaseDefinition;
    expect(typeof phase.func).toBe("function");
    // 验证不是抛错 stub（stub 会立刻抛）
    expect(phase.func!.toString()).not.toContain('阶段函数 "run_do_it" 未定义');
  });

  it("phase 既无 prompt 又无 ts → 绑定的 func 调用时抛错", async () => {
    const wfDir = join(tmpHome, "workflows", "stub");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "workflow.json"),
      JSON.stringify({
        name: "stub",
        phases: [{ name: "empty" }],
      }, null, 2),
      "utf-8",
    );

    const wf = await loadJsonWorkflow(wfDir);
    const phase = wf!.phases[0] as PhaseDefinition;
    await expect(phase.func!("t1")).rejects.toThrow(/未定义且未提供 prompt|未定义/);
  });

  it("ts 有 run_ 函数 + json 也有 prompt → 提示词优先，用 prompt-runner（忽略 ts）", async () => {
    const wfDir = join(tmpHome, "workflows", "both");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "workflow.json"),
      JSON.stringify({
        name: "both",
        phases: [{ name: "do_it", prompt: "this is json prompt" }],
      }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(wfDir, "workflow.ts"),
      `export async function run_do_it(_taskId: string): Promise<void> {
  throw new Error("从 ts 函数抛出");
}`,
      "utf-8",
    );

    const wf = await loadJsonWorkflow(wfDir);
    const phase = wf!.phases[0] as PhaseDefinition;
    // 提示词优先（全局翻转）：phase 绑定 prompt-runner 而非 ts 函数 → 绑定的 func 源码不含 ts 的抛错串
    expect(phase.func!.toString()).not.toContain("从 ts 函数抛出");
  });
});

describe("phaseUsesDeliverables（B²：建 deliverables 目录由 phase 引用 ${DELIVERABLES} 驱动，不读顶层 delivers）", () => {
  it("引用 ${DELIVERABLES}（花括号）→ true", () => {
    expect(phaseUsesDeliverables("把产物写到 ${DELIVERABLES} 目录")).toBe(true);
  });

  it("引用 $DELIVERABLES（简写）→ true", () => {
    expect(phaseUsesDeliverables("产物落到 $DELIVERABLES 下")).toBe(true);
  });

  it("不引用 → false（如 PR 工作流的开发阶段，只用 ${WORKSPACE}）", () => {
    expect(phaseUsesDeliverables("在 ${WORKSPACE} 改代码，别碰 git")).toBe(false);
  });

  it("$DELIVERABLESX 等前缀粘连 → false（单词边界，不误判）", () => {
    expect(phaseUsesDeliverables("$DELIVERABLESX 不是它")).toBe(false);
  });

  it("空 prompt → false", () => {
    expect(phaseUsesDeliverables("")).toBe(false);
  });

  it("多产物场景：每个 phase 的 prompt 独立判断——只有引用的那个为 true", () => {
    // 这是修「多产物阶段误校验」bug 的核心：现状读顶层 wf.delivers 会给所有产出阶段都强制非空，
    // 改后按各 phase 自己是否引用 ${DELIVERABLES} 判定，互不牵连。
    const producePrompt = "第一阶段产出，写到 ${DELIVERABLES}";
    const reviewPrompt = "第二阶段只评审 ${HANDOFF_produce}，不产文件";
    expect(phaseUsesDeliverables(producePrompt)).toBe(true);
    expect(phaseUsesDeliverables(reviewPrompt)).toBe(false);
  });
});
