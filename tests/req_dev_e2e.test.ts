import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, getTask } from "../src/core/db";
import { _clearRegistry, register } from "../src/core/registry";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { createRepo } from "../src/core/repos";
import { startTaskFromTemplate } from "../src/core/task-factory";
import { setup_req_dev_task } from "../examples/workflows/req_dev/workflow";
import type { WorkflowDefinition } from "../src/core/registry";

describe("req_dev e2e smoke", () => {
  let sqlite: Database;

  beforeAll(() => {
    // 初始化测试数据库
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    initDb();
    migrate001(sqlite);
    migrate002(sqlite);
    migrate004(sqlite);

    // 创建测试 repo
    createRepo({
      id: "repo-001",
      alias: "autopilot",
      path: process.cwd(),
      default_branch: "main",
      github_owner: "larrygogo",
      github_repo: "autopilot",
    });

    // 手动注册 req_dev workflow（避免文件系统依赖）
    _clearRegistry();
    const req_dev_workflow: WorkflowDefinition = {
      name: "req_dev",
      description: "需求驱动开发流程",
      setup_func: setup_req_dev_task,
      phases: [
        {
          name: "design",
          pending_state: "pending_design",
          running_state: "running_design",
          trigger: "start_design",
          complete_trigger: "design_complete",
          fail_trigger: "design_fail",
          label: "DESIGN",
          timeout: 900,
          func: async (_taskId: string) => {
            // stub
          },
        },
        {
          name: "review",
          pending_state: "pending_review",
          running_state: "running_review",
          trigger: "start_review",
          complete_trigger: "review_complete",
          fail_trigger: "review_fail",
          label: "REVIEW",
          timeout: 900,
          reject: "design",
          jump_trigger: "review_reject",
          jump_target: "design",
          max_rejections: 10,
          _jump_origin: "reject",
          func: async (_taskId: string) => {
            // stub
          },
        },
        {
          name: "develop",
          pending_state: "pending_develop",
          running_state: "running_develop",
          trigger: "start_develop",
          complete_trigger: "develop_complete",
          fail_trigger: "develop_fail",
          label: "DEVELOP",
          timeout: 1800,
          func: async (_taskId: string) => {
            // stub
          },
        },
        {
          name: "code_review",
          pending_state: "pending_code_review",
          running_state: "running_code_review",
          trigger: "start_code_review",
          complete_trigger: "code_review_complete",
          fail_trigger: "code_review_fail",
          label: "CODE_REVIEW",
          timeout: 1200,
          reject: "develop",
          jump_trigger: "code_review_reject",
          jump_target: "develop",
          max_rejections: 10,
          _jump_origin: "reject",
          func: async (_taskId: string) => {
            // stub
          },
        },
        {
          name: "submit_pr",
          pending_state: "pending_submit_pr",
          running_state: "running_submit_pr",
          trigger: "start_submit_pr",
          complete_trigger: "submit_pr_complete",
          fail_trigger: "submit_pr_fail",
          label: "SUBMIT_PR",
          timeout: 300,
          func: async (_taskId: string) => {
            // stub
          },
        },
      ],
      initial_state: "pending_design",
      terminal_states: ["done", "cancelled"],
    };
    register(req_dev_workflow);
  });

  afterAll(() => {
    _setDbForTest(null);
    _clearRegistry();
    sqlite.close();
  });

  it("通过任务工厂创建 req_dev task，setup_func 注入派生字段到 extra", async () => {
    // 用工厂创建 task（传入 repo_id 作为额外参数）
    // 注意：工厂会自动执行第一阶段，所以返回时状态可能已转移
    const task = await startTaskFromTemplate({
      workflow: "req_dev",
      title: "smoke test requirement",
      requirement: "test requirement content",
      repo_id: "repo-001", // 额外工作流参数，转发给 setup_func
    });

    // 验证 task 本体
    expect(task).not.toBeNull();
    expect(task.id).toBeTruthy();
    expect(task.workflow).toBe("req_dev");
    expect(task.title).toBe("smoke test requirement");

    // 验证派生字段（扁平化在 task 对象上，不在单独的 extra 属性）
    // 派生自 repo_id 的字段
    expect(task["repo_id"]).toBe("repo-001");
    expect(task["repo_path"]).toBe(process.cwd());
    expect(task["default_branch"]).toBe("main");
    expect(task["github_owner"]).toBe("larrygogo");
    expect(task["github_repo"]).toBe("autopilot");

    // 派生自 title 的字段
    expect((task["branch"] as string).startsWith("feat/")).toBe(true);
    expect((task["branch"] as string).includes("smoke")).toBe(true);

    // requirement 字段
    expect(task["requirement"]).toBe("test requirement content");

    // 从 DB 再读一遍，验证持久化
    const storedTask = getTask(task.id);
    expect(storedTask).not.toBeNull();
    expect(storedTask!.workflow).toBe("req_dev");
    expect(storedTask!["repo_id"]).toBe("repo-001");
    expect(storedTask!["github_owner"]).toBe("larrygogo");
  });

  it("工厂缺少 requirement 时自动补充为空串", async () => {
    const task = await startTaskFromTemplate({
      workflow: "req_dev",
      title: "no requirement",
      repo_id: "repo-001", // 额外工作流参数
      // requirement 未传
    });

    expect(task).not.toBeNull();
    expect(task["requirement"]).toBe("");
  });
});
