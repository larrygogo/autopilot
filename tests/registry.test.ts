import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  expandPhaseDefaults,
  loadYamlWorkflow,
  buildTransitions,
  register,
  getWorkflow,
  listWorkflows,
  getPhase,
  getPhaseFunc,
  _clearRegistry,
  type WorkflowDefinition,
  type PhaseDefinition,
} from "../src/core/registry";

// 每个测试前清空注册表
beforeEach(() => {
  _clearRegistry();
});

// ──────────────────────────────────────────────
// 辅助：创建临时目录
// ──────────────────────────────────────────────
function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `autopilot-test-${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ──────────────────────────────────────────────
// 1. expandPhaseDefaults 推导所有默认值
// ──────────────────────────────────────────────
describe("expandPhaseDefaults", () => {
  it("应当推导所有默认字段", () => {
    const phase = expandPhaseDefaults({ name: "design" }, new Set(["design"]));

    expect(phase.pending_state).toBe("pending_design");
    expect(phase.running_state).toBe("running_design");
    expect(phase.trigger).toBe("start_design");
    expect(phase.complete_trigger).toBe("design_complete");
    expect(phase.fail_trigger).toBe("design_fail");
    expect(phase.label).toBe("DESIGN");
  });

  it("应当保留用户自定义字段", () => {
    const phase = expandPhaseDefaults(
      { name: "review", timeout: 1800, agent: "claude" },
      new Set(["review"])
    );

    expect(phase.timeout).toBe(1800);
    expect(phase.agent).toBe("claude");
    expect(phase.label).toBe("REVIEW");
  });

  // ──────────────────────────────────────────────
  // 2. expandPhaseDefaults 处理 reject 语法糖
  // ──────────────────────────────────────────────
  it("应当处理 reject 语法糖", () => {
    const phase = expandPhaseDefaults(
      { name: "code_review", reject: "design" },
      new Set(["design", "code_review"])
    );

    expect(phase.jump_trigger).toBe("code_review_reject");
    expect(phase.jump_target).toBe("design");
    expect(phase._jump_origin).toBe("reject");
    expect(phase.max_rejections).toBe(10);
    expect(phase["reject"]).toBeUndefined();
  });

  it("reject 不覆盖已有 jump_trigger", () => {
    const phase = expandPhaseDefaults(
      { name: "review", reject: "design", jump_trigger: "custom_reject" },
      new Set(["design", "review"])
    );

    expect(phase.jump_trigger).toBe("custom_reject");
    expect(phase.jump_target).toBe("design");
  });
});

// ──────────────────────────────────────────────
// 3. loadYamlWorkflow 解析基本工作流
// ──────────────────────────────────────────────
describe("loadYamlWorkflow", () => {
  it("应当解析基本工作流 YAML", async () => {
    const dir = makeTmpDir("basic");
    try {
      writeFileSync(
        join(dir, "workflow.yaml"),
        `
name: basic_test
description: 测试工作流
phases:
  - name: step1
    timeout: 900
  - name: step2
    timeout: 600
`
      );

      const wf = await loadYamlWorkflow(dir);

      expect(wf).not.toBeNull();
      expect(wf!.name).toBe("basic_test");
      expect(wf!.description).toBe("测试工作流");
      expect(wf!.phases.length).toBe(2);

      const step1 = wf!.phases[0] as PhaseDefinition;
      expect(step1.name).toBe("step1");
      expect(step1.pending_state).toBe("pending_step1");
      expect(step1.running_state).toBe("running_step1");
      expect(step1.trigger).toBe("start_step1");
      expect(step1.timeout).toBe(900);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────
  // 4. loadYamlWorkflow 推导 initial_state 和 terminal_states
  // ──────────────────────────────────────────────
  it("应当推导 initial_state 和 terminal_states", async () => {
    const dir = makeTmpDir("states");
    try {
      writeFileSync(
        join(dir, "workflow.yaml"),
        `
name: state_test
phases:
  - name: alpha
  - name: beta
`
      );

      const wf = await loadYamlWorkflow(dir);

      expect(wf!.initial_state).toBe("pending_alpha");
      expect(wf!.terminal_states).toEqual(["done", "cancelled"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不存在 workflow.yaml 时返回 null", async () => {
    const dir = makeTmpDir("empty");
    try {
      const wf = await loadYamlWorkflow(dir);
      expect(wf).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("应当绑定 workflow.ts 中的阶段函数", async () => {
    const dir = makeTmpDir("with-ts");
    try {
      writeFileSync(
        join(dir, "workflow.yaml"),
        `
name: ts_test
phases:
  - name: build
`
      );
      writeFileSync(
        join(dir, "workflow.ts"),
        `export async function run_build(taskId: string) { return; }`
      );

      const wf = await loadYamlWorkflow(dir);
      expect(wf).not.toBeNull();
      const build = wf!.phases[0] as PhaseDefinition;
      expect(typeof build.func).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// 5. buildTransitions 生成正确的转换表（2 阶段线性）
// ──────────────────────────────────────────────
describe("buildTransitions", () => {
  it("应当为 2 阶段线性工作流生成正确的转换表", () => {
    const wf: WorkflowDefinition = {
      name: "linear",
      phases: [
        expandPhaseDefaults({ name: "step1" }, new Set(["step1", "step2"])),
        expandPhaseDefaults({ name: "step2" }, new Set(["step1", "step2"])),
      ],
      initial_state: "pending_step1",
      terminal_states: ["done", "cancelled"],
    };

    const t = buildTransitions(wf);

    // step1: pending → running → pending_step2
    expect(t["pending_step1"]).toContainEqual(["start_step1", "running_step1"]);
    expect(t["running_step1"]).toContainEqual(["step1_complete", "pending_step2"]);
    expect(t["running_step1"]).toContainEqual(["step1_fail", "pending_step1"]);

    // step2: pending → running → done
    expect(t["pending_step2"]).toContainEqual(["start_step2", "running_step2"]);
    expect(t["running_step2"]).toContainEqual(["step2_complete", "done"]);
    expect(t["running_step2"]).toContainEqual(["step2_fail", "pending_step2"]);
  });

  // ──────────────────────────────────────────────
  // 6. buildTransitions 处理 reject/jump 转换
  // ──────────────────────────────────────────────
  it("应当处理 reject/jump 转换", () => {
    const allNames = new Set(["design", "review"]);
    const wf: WorkflowDefinition = {
      name: "with_reject",
      phases: [
        expandPhaseDefaults({ name: "design" }, allNames),
        expandPhaseDefaults({ name: "review", reject: "design" }, allNames),
      ],
      initial_state: "pending_design",
      terminal_states: ["done", "cancelled"],
    };

    const t = buildTransitions(wf);

    // review running → review_rejected（via review_reject）
    expect(t["running_review"]).toContainEqual(["review_reject", "review_rejected"]);

    // review_rejected → pending_design（via retry_design）
    expect(t["review_rejected"]).toContainEqual(["retry_design", "pending_design"]);

    // review_rejected 也有 cancel
    expect(t["review_rejected"]).toContainEqual(["cancel", "cancelled"]);
  });

  // ──────────────────────────────────────────────
  // 7. buildTransitions 处理 parallel 块
  // ──────────────────────────────────────────────
  it("应当处理 parallel 块的 fork/join 转换", () => {
    const wf: WorkflowDefinition = {
      name: "with_parallel",
      phases: [
        expandPhaseDefaults({ name: "design" }, new Set(["design", "frontend", "backend", "review"])),
        {
          parallel: {
            name: "development",
            fail_strategy: "cancel_all",
            phases: [
              expandPhaseDefaults({ name: "frontend" }, new Set(["design", "frontend", "backend", "review"])),
              expandPhaseDefaults({ name: "backend" }, new Set(["design", "frontend", "backend", "review"])),
            ],
          },
        },
        expandPhaseDefaults({ name: "review" }, new Set(["design", "frontend", "backend", "review"])),
      ],
      initial_state: "pending_design",
      terminal_states: ["done", "cancelled"],
    };

    const t = buildTransitions(wf);

    // fork: pending_development → waiting_development
    expect(t["pending_development"]).toContainEqual(["start_development", "waiting_development"]);

    // 子阶段独立转换
    expect(t["pending_frontend"]).toContainEqual(["start_frontend", "running_frontend"]);
    expect(t["running_frontend"]).toContainEqual(["frontend_complete", "frontend_done"]);
    expect(t["pending_backend"]).toContainEqual(["start_backend", "running_backend"]);

    // join: waiting_development → pending_review
    expect(t["waiting_development"]).toContainEqual(["development_complete", "pending_review"]);

    // fail trigger for parallel group
    expect(t["waiting_development"]).toContainEqual(["development_fail", "pending_development"]);
  });

  // ──────────────────────────────────────────────
  // 8. buildTransitions 所有非终态有 cancel
  // ──────────────────────────────────────────────
  it("所有非终态状态应有 cancel → cancelled 转换", () => {
    const wf: WorkflowDefinition = {
      name: "cancel_test",
      phases: [
        expandPhaseDefaults({ name: "a" }, new Set(["a", "b"])),
        expandPhaseDefaults({ name: "b" }, new Set(["a", "b"])),
      ],
      initial_state: "pending_a",
      terminal_states: ["done", "cancelled"],
    };

    const t = buildTransitions(wf);
    const terminalStates = new Set(["done", "cancelled"]);

    for (const [state, transitions] of Object.entries(t)) {
      if (!terminalStates.has(state)) {
        const hasCancelTrigger = transitions.some(([trigger]) => trigger === "cancel");
        expect(hasCancelTrigger).toBe(true);
      }
    }
  });

  it("如果 workflow 已有 transitions，直接返回", () => {
    const customTransitions: import("../src/core/state-machine").TransitionTable = {
      pending_x: [["start_x", "running_x"]],
    };
    const wf: WorkflowDefinition = {
      name: "custom_trans",
      phases: [],
      initial_state: "pending_x",
      terminal_states: ["done"],
      transitions: customTransitions,
    };

    const t = buildTransitions(wf);
    expect(t).toBe(customTransitions);
  });
});

// ──────────────────────────────────────────────
// 9. register + getWorkflow + listWorkflows
// ──────────────────────────────────────────────
describe("register / getWorkflow / listWorkflows", () => {
  it("应当注册并查询工作流", () => {
    const wf: WorkflowDefinition = {
      name: "my_workflow",
      description: "测试注册",
      phases: [],
      initial_state: "pending_step1",
      terminal_states: ["done"],
    };

    register(wf);

    const found = getWorkflow("my_workflow");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("my_workflow");
    expect(found!.description).toBe("测试注册");
  });

  it("未注册工作流应返回 null", () => {
    expect(getWorkflow("nonexistent")).toBeNull();
  });

  it("listWorkflows 应列出所有已注册工作流", () => {
    register({
      name: "wf_a",
      description: "A",
      phases: [],
      initial_state: "pending",
      terminal_states: ["done"],
    });
    register({
      name: "wf_b",
      description: "B",
      phases: [],
      initial_state: "pending",
      terminal_states: ["done"],
    });

    const list = listWorkflows();
    expect(list.length).toBe(2);
    const names = list.map((w) => w.name);
    expect(names).toContain("wf_a");
    expect(names).toContain("wf_b");
  });

  it("注册同名工作流应覆盖", () => {
    register({
      name: "dup",
      description: "first",
      phases: [],
      initial_state: "pending",
      terminal_states: ["done"],
    });
    register({
      name: "dup",
      description: "second",
      phases: [],
      initial_state: "pending",
      terminal_states: ["done"],
    });

    expect(getWorkflow("dup")!.description).toBe("second");
    expect(listWorkflows().length).toBe(1);
  });
});

// ──────────────────────────────────────────────
// 10. getPhase + getPhaseFunc 查询
// ──────────────────────────────────────────────
describe("getPhase / getPhaseFunc", () => {
  it("应当返回普通阶段定义", () => {
    const phase1 = expandPhaseDefaults({ name: "step1" }, new Set(["step1"]));
    phase1.func = async (_id: string) => {};

    register({
      name: "query_test",
      phases: [phase1],
      initial_state: "pending_step1",
      terminal_states: ["done"],
    });

    const found = getPhase("query_test", "step1");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("step1");
    expect(found!.pending_state).toBe("pending_step1");
  });

  it("应当返回 parallel 子阶段定义", () => {
    const frontend = expandPhaseDefaults({ name: "frontend" }, new Set(["frontend", "backend"]));
    frontend.func = async (_id: string) => {};
    const backend = expandPhaseDefaults({ name: "backend" }, new Set(["frontend", "backend"]));
    backend.func = async (_id: string) => {};

    register({
      name: "parallel_query",
      phases: [{ parallel: { name: "dev", fail_strategy: "cancel_all", phases: [frontend, backend] } }],
      initial_state: "pending_dev",
      terminal_states: ["done"],
    });

    const found = getPhase("parallel_query", "backend");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("backend");
  });

  it("不存在的阶段应返回 null", () => {
    register({
      name: "empty_wf",
      phases: [],
      initial_state: "pending",
      terminal_states: ["done"],
    });

    expect(getPhase("empty_wf", "nonexistent")).toBeNull();
  });

  it("getPhaseFunc 应返回阶段函数", () => {
    const mockFunc = async (_id: string) => {};
    const phase = expandPhaseDefaults({ name: "alpha" }, new Set(["alpha"]));
    phase.func = mockFunc;

    register({
      name: "func_test",
      phases: [phase],
      initial_state: "pending_alpha",
      terminal_states: ["done"],
    });

    const fn = getPhaseFunc("func_test", "alpha");
    expect(fn).toBe(mockFunc);
  });

  it("getPhaseFunc 工作流不存在应返回 null", () => {
    expect(getPhaseFunc("no_such_wf", "step")).toBeNull();
  });
});
