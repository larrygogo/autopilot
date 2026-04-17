import { Command } from "commander";
import { mkdirSync } from "fs";
import { join } from "path";
import { VERSION, AUTOPILOT_HOME } from "../index";
import { initDb } from "../core/db";
import { runPendingMigrations } from "../core/migrate";
import { AutopilotClient, DEFAULT_PORT, DEFAULT_HOST } from "../client/index";
import { readPid, isProcessAlive, isDaemonRunning, removePid } from "../daemon/pid";

// ──────────────────────────────────────────────
// CLI 主程序
// ──────────────────────────────────────────────

const program = new Command();

program
  .name("autopilot")
  .description("轻量级多阶段任务编排引擎")
  .version(VERSION, "-V, --version");

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

function getClient(opts?: { port?: string }): AutopilotClient {
  const port = opts?.port ? parseInt(opts.port, 10) : DEFAULT_PORT;
  return new AutopilotClient({ port });
}

async function ensureDaemon(client: AutopilotClient): Promise<void> {
  try {
    await client.getStatus();
  } catch {
    console.error("错误：无法连接到 daemon。请先运行 `autopilot daemon run`。");
    process.exit(1);
  }
}

// ──────────────────────────────────────────────
// daemon — daemon 生命周期管理
// ──────────────────────────────────────────────

const daemon = program.command("daemon").description("daemon 生命周期管理");

daemon
  .command("run")
  .description("前台启动 daemon")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .option("-H, --host <host>", "主机", DEFAULT_HOST)
  .action(async (opts: { port: string; host: string }) => {
    const { startDaemon } = await import("../daemon/index");
    await startDaemon({ host: opts.host, port: parseInt(opts.port, 10) });
  });

daemon
  .command("start")
  .description("后台启动 daemon")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    if (isDaemonRunning()) {
      console.error("错误：daemon 已在运行中。");
      process.exit(1);
    }

    const child = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "../daemon/index.ts"), "--port", opts.port],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    child.unref();

    // 等待 PID 文件出现
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await Bun.sleep(200);
      const pid = readPid();
      if (pid && isProcessAlive(pid)) {
        console.log(`daemon 已启动 (pid=${pid}, port=${opts.port})`);
        return;
      }
    }
    console.error("错误：daemon 启动超时。");
    process.exit(1);
  });

daemon
  .command("stop")
  .description("停止 daemon")
  .action(async () => {
    const pid = readPid();
    if (!pid || !isProcessAlive(pid)) {
      console.log("daemon 未在运行。");
      removePid();
      return;
    }

    process.kill(pid, "SIGTERM");

    // 等待退出
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await Bun.sleep(200);
      if (!isProcessAlive(pid)) {
        console.log("daemon 已停止。");
        return;
      }
    }
    console.error("错误：daemon 停止超时。");
    process.exit(1);
  });

daemon
  .command("status")
  .description("查看 daemon 状态")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    const pid = readPid();
    if (!pid || !isProcessAlive(pid)) {
      console.log("daemon 未在运行。");
      return;
    }

    try {
      const client = getClient(opts);
      const status = await client.getStatus();
      console.log(`daemon 运行中 (pid=${status.pid})`);
      console.log(`  版本: ${status.version}`);
      console.log(`  运行时间: ${status.uptime}s`);
      const counts = Object.entries(status.taskCounts);
      if (counts.length > 0) {
        console.log(`  任务统计:`);
        for (const [state, count] of counts) {
          console.log(`    ${state}: ${count}`);
        }
      } else {
        console.log(`  任务统计: 无任务`);
      }
    } catch {
      console.log(`daemon 进程存在 (pid=${pid})，但 API 无响应。`);
    }
  });

// ──────────────────────────────────────────────
// task — 任务管理
// ──────────────────────────────────────────────

const task = program.command("task").description("任务管理");

task
  .command("start <req-id>")
  .description("创建并启动任务")
  .option("-t, --title <title>", "任务标题")
  .option("-w, --workflow <name>", "工作流名称")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (reqId: string, opts: { title?: string; workflow?: string; port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    try {
      const t = await client.startTask({ reqId, title: opts.title, workflow: opts.workflow });
      console.log(`任务已创建 [id=${t.id} workflow=${t.workflow} status=${t.status}]`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

task
  .command("status [task-id]")
  .description("查看任务状态")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (taskId: string | undefined, opts: { port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    if (taskId) {
      try {
        const t = await client.getTask(taskId);
        console.log(JSON.stringify(t, null, 2));
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    } else {
      const tasks = await client.listTasks();
      if (tasks.length === 0) {
        console.log("暂无任务。");
        return;
      }

      const cols = ["id", "title", "workflow", "status", "created_at"] as const;
      const widths = cols.map((col) =>
        Math.max(col.length, ...tasks.map((t: any) => String(t[col] ?? "").length))
      );
      const header = cols.map((col, i) => col.padEnd(widths[i])).join("  ");
      const divider = widths.map((w) => "-".repeat(w)).join("  ");
      console.log(header);
      console.log(divider);
      for (const t of tasks) {
        const row = cols
          .map((col, i) => String((t as any)[col] ?? "").padEnd(widths[i]))
          .join("  ");
        console.log(row);
      }
    }
  });

task
  .command("cancel <task-id>")
  .description("取消任务")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (taskId: string, opts: { port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    try {
      const result = await client.cancelTask(taskId);
      console.log(`任务已取消 [id=${taskId} ${result.from} → ${result.to}]`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

task
  .command("logs <task-id>")
  .description("查看任务日志")
  .option("-f, --follow", "实时跟踪日志")
  .option("-n, --limit <limit>", "日志条数", "50")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (taskId: string, opts: { follow?: boolean; limit: string; port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    // 先获取历史日志
    const logs = await client.getTaskLogs(taskId, parseInt(opts.limit, 10));
    for (const log of logs.reverse()) {
      console.log(`${log.created_at}  ${log.from_status ?? "-"} → ${log.to_status}  [${log.trigger_name ?? "-"}]  ${log.note ?? ""}`);
    }

    if (opts.follow) {
      // 通过 WebSocket 实时跟踪
      client.connect();
      client.subscribe(`log:${taskId}`, (event) => {
        if (event.type === "log:entry") {
          console.log(event.payload.message);
        }
      });
      client.subscribe(`task:${taskId}`, (event) => {
        if (event.type === "task:transition") {
          console.log(`[状态转换] ${event.payload.from} → ${event.payload.to} (${event.payload.trigger})`);
        }
      });

      // 保持运行，直到 Ctrl+C
      await new Promise(() => {});
    }
  });

// ──────────────────────────────────────────────
// workflow — 工作流管理
// ──────────────────────────────────────────────

const workflow = program.command("workflow").description("工作流管理");

workflow
  .command("list")
  .description("列出已注册工作流")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    const workflows = await client.listWorkflows();
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
// tui — 终端 UI
// ──────────────────────────────────────────────

program
  .command("tui")
  .description("启动终端 UI")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    try {
      const { startTui } = await import("../tui/index");
      startTui({ port: parseInt(opts.port, 10) });
    } catch (e: unknown) {
      console.error("错误：TUI 模块未安装。请运行 `bun install` 安装依赖。");
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// dashboard — 打开 Web UI
// ──────────────────────────────────────────────

program
  .command("dashboard")
  .description("打开 Web 控制台")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    const url = `http://${DEFAULT_HOST}:${opts.port}`;
    console.log(`打开浏览器：${url}`);
    const platform = process.platform;
    const cmd: string[] =
      platform === "darwin" ? ["open", url]
      : platform === "win32" ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
    try {
      const proc = Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
      const code = await proc.exited;
      if (code !== 0) {
        console.error(`无法自动打开浏览器（${cmd[0]} 退出码 ${code}），请手动访问上面的 URL。`);
      }
    } catch (e: unknown) {
      console.error(`无法运行 ${cmd[0]}：${e instanceof Error ? e.message : String(e)}`);
      console.error("请手动在浏览器中访问上面的 URL。");
    }
  });

// ──────────────────────────────────────────────
// init — 初始化（本地，不需要 daemon）
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
// upgrade — 运行数据库迁移（本地，不需要 daemon）
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
