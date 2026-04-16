#!/usr/bin/env bun
import { Command } from "commander";
import { mkdirSync } from "fs";
import { join } from "path";
import { VERSION, AUTOPILOT_HOME } from "./index";
import { initDb, createTask, getTask, listTasks } from "./core/db";
import { runPendingMigrations } from "./core/migrate";
import {
  discover,
  listWorkflows,
  getWorkflow,
  buildTransitions,
  isParallelPhase,
} from "./core/registry";
import { executePhase } from "./core/runner";
import { transition } from "./core/state-machine";

// ──────────────────────────────────────────────
// CLI 主程序
// ──────────────────────────────────────────────

const program = new Command();

program
  .name("autopilot")
  .description("轻量级多阶段任务编排引擎")
  .version(VERSION, "-V, --version");

// ──────────────────────────────────────────────
// init — 初始化 AUTOPILOT_HOME
// ──────────────────────────────────────────────

program
  .command("init")
  .description("初始化 AUTOPILOT_HOME 目录结构和数据库")
  .action(() => {
    const dirs = [
      join(AUTOPILOT_HOME, "workflows"),
      join(AUTOPILOT_HOME, "prompts"),
      join(AUTOPILOT_HOME, "runtime"),
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      console.log(`已创建目录：${dir}`);
    }
    initDb();
    console.log(`已初始化数据库：${join(AUTOPILOT_HOME, "runtime", "workflow.db")}`);
    console.log("初始化完成。");
  });

// ──────────────────────────────────────────────
// start — 注册并启动任务
// ──────────────────────────────────────────────

program
  .command("start <req-id>")
  .description("注册并启动任务")
  .option("-t, --title <title>", "任务标题")
  .option("-w, --workflow <name>", "工作流名称")
  .action(async (reqId: string, opts: { title?: string; workflow?: string }) => {
    initDb();
    await discover();

    const workflows = listWorkflows();
    if (workflows.length === 0) {
      console.error("错误：未发现任何工作流，请先在 AUTOPILOT_HOME/workflows/ 中添加工作流。");
      process.exit(1);
    }

    let workflowName: string;
    if (opts.workflow) {
      workflowName = opts.workflow;
    } else if (workflows.length === 1) {
      workflowName = workflows[0].name;
    } else {
      console.error(
        `错误：发现多个工作流，请通过 --workflow 指定。\n可用工作流：${workflows.map((w) => w.name).join(", ")}`
      );
      process.exit(1);
    }

    const workflow = getWorkflow(workflowName);
    if (!workflow) {
      console.error(`错误：工作流 "${workflowName}" 不存在。`);
      process.exit(1);
    }

    const taskId = reqId.slice(0, 8);
    const title = opts.title ?? reqId;

    // 调用 setup_func（如果有）获取 extra 参数
    let extra: Record<string, unknown> = {};
    if (typeof workflow.setup_func === "function") {
      try {
        extra = workflow.setup_func({ reqId, title, taskId }) ?? {};
      } catch (e: any) {
        console.error(`setup_func 执行失败：${e.message}`);
        process.exit(1);
      }
    }

    // 获取第一个阶段
    const firstPhaseEntry = workflow.phases[0];
    if (!firstPhaseEntry) {
      console.error("错误：工作流没有定义任何阶段。");
      process.exit(1);
    }
    const firstPhaseName =
      isParallelPhase(firstPhaseEntry)
        ? firstPhaseEntry.parallel.name
        : firstPhaseEntry.name;

    // 创建任务
    createTask({
      id: taskId,
      title,
      workflow: workflowName,
      initialStatus: workflow.initial_state,
      extra,
    });

    console.log(`任务已创建 [id=${taskId} workflow=${workflowName} status=${workflow.initial_state}]`);

    // 执行第一个阶段
    await executePhase(taskId, firstPhaseName);
  });

// ──────────────────────────────────────────────
// status — 查看任务状态
// ──────────────────────────────────────────────

program
  .command("status [task-id]")
  .description("查看单个任务（JSON）或列出所有任务（表格）")
  .action((taskId?: string) => {
    initDb();

    if (taskId) {
      const task = getTask(taskId);
      if (!task) {
        console.error(`错误：任务 "${taskId}" 不存在。`);
        process.exit(1);
      }
      console.log(JSON.stringify(task, null, 2));
    } else {
      const tasks = listTasks();
      if (tasks.length === 0) {
        console.log("暂无任务。");
        return;
      }

      // 打印表格
      const cols = ["id", "title", "workflow", "status", "created_at"] as const;
      const widths = cols.map((col) =>
        Math.max(col.length, ...tasks.map((t) => String(t[col] ?? "").length))
      );

      const header = cols.map((col, i) => col.padEnd(widths[i])).join("  ");
      const divider = widths.map((w) => "-".repeat(w)).join("  ");
      console.log(header);
      console.log(divider);
      for (const task of tasks) {
        const row = cols
          .map((col, i) => String(task[col] ?? "").padEnd(widths[i]))
          .join("  ");
        console.log(row);
      }
    }
  });

// ──────────────────────────────────────────────
// cancel — 取消任务
// ──────────────────────────────────────────────

program
  .command("cancel <task-id>")
  .description("取消任务")
  .action((taskId: string) => {
    initDb();

    const task = getTask(taskId);
    if (!task) {
      console.error(`错误：任务 "${taskId}" 不存在。`);
      process.exit(1);
    }

    // 检查是否已处于终态
    const terminalStates = new Set(["done", "cancelled"]);
    const wf = getWorkflow(task.workflow);
    if (wf) {
      for (const s of wf.terminal_states ?? []) terminalStates.add(s);
    }
    if (terminalStates.has(task.status)) {
      console.error(`任务已处于终态 "${task.status}"，无需取消。`);
      process.exit(1);
    }

    // 优先使用工作流转换表，回退到最小转换表
    let transitions;
    if (wf) {
      transitions = buildTransitions(wf);
    } else {
      transitions = {
        [task.status]: [["cancel", "cancelled"] as [string, string]],
      };
    }

    try {
      const [from, to] = transition(taskId, "cancel", {
        transitions,
        note: "CLI 手动取消",
      });
      console.log(`任务已取消 [id=${taskId} ${from} → ${to}]`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`取消失败：${message}`);
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// list — 列出已注册工作流
// ──────────────────────────────────────────────

program
  .command("list")
  .description("列出已注册工作流")
  .action(async () => {
    await discover();
    const workflows = listWorkflows();

    if (workflows.length === 0) {
      console.log("暂无已注册工作流。");
      return;
    }

    console.log(`已注册工作流（共 ${workflows.length} 个）：\n`);
    for (const wf of workflows) {
      const desc = wf.description ? `  — ${wf.description}` : "";
      console.log(`  ${wf.name}${desc}`);
    }
  });

// ──────────────────────────────────────────────
// upgrade — 运行数据库迁移
// ──────────────────────────────────────────────

program
  .command("upgrade")
  .description("运行数据库迁移")
  .action(async () => {
    initDb();
    const count = await runPendingMigrations();
    if (count === 0) {
      console.log("数据库已是最新版本，无需迁移。");
    } else {
      console.log(`数据库升级完成，共执行 ${count} 条迁移。`);
    }
  });

// ──────────────────────────────────────────────
// 启动
// ──────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error("CLI 错误：", err);
  process.exit(1);
});
