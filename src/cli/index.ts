import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { buildConfigTemplate } from "./config-template";
import { VERSION, AUTOPILOT_HOME } from "../index";
import { initDb, closeDb } from "../core/db";
import { runPendingMigrations } from "../core/migrate";
import { rebuildIndexFromManifests, rebuildManifestsFromIndex } from "../core/rebuild-index";
import { discover } from "../core/registry";
import { DEFAULT_PORT, DEFAULT_HOST } from "../client/index";
import { registerWorkflowCommands } from "./workflow";
import { registerConfigCommands, printReport as printDoctorReport } from "./config";
import { registerRequirementCommands } from "./requirements-cli";
import { registerDaemonCommands } from "./daemon";
import { registerTaskCommands } from "./task";
import { registerChatCommands } from "./chat";
import { registerNowCommands } from "./now";
import { runChecks as runDoctorChecks } from "../core/doctor";
import { isDaemonRunning } from "../daemon/pid";
import { getClient, ensureDaemon } from "./utils";

// ──────────────────────────────────────────────
// CLI 主程序
// ──────────────────────────────────────────────

const program = new Command();

program
  .name("autopilot")
  .description("轻量级多阶段任务编排引擎")
  .version(VERSION, "-V, --version");

// 命令组拆分（按命令名一文件）
registerDaemonCommands(program);
registerTaskCommands(program);
registerChatCommands(program);
registerNowCommands(program);
registerWorkflowCommands(program, {
  getClient,
  ensureDaemon,
  defaultPort: DEFAULT_PORT,
});
registerConfigCommands(program);
registerRequirementCommands(program);

program
  .command("doctor")
  .description("config doctor 的顶层别名")
  .option("--probe", "包含 L2 + L3 探测")
  .option("--json", "JSON 输出")
  .option("--fix", "交互式修复")
  .action(async (opts: { probe?: boolean; json?: boolean; fix?: boolean }) => {
    const args = ["config", "doctor"];
    if (opts.probe) args.push("--probe");
    if (opts.json) args.push("--json");
    if (opts.fix) args.push("--fix");
    await program.parseAsync(args, { from: "user" });
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
// ──────────────────────────────────────────────
// start — 快捷创建任务（task start 的顶层别名）
// ──────────────────────────────────────────────

program
  .command("start <title>")
  .description("快捷创建并启动任务（task start 的顶层别名）")
  .option("-w, --workflow <name>", "工作流名称")
  .option("-r, --requirement <text>", "需求详情；以 @ 开头则从文件读")
  .option("--repo <alias>", "绑定仓库别名")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (title: string, opts: { workflow?: string; requirement?: string; repo?: string; port: string }) => {
    try {
      const preflight = await runDoctorChecks({ level: 2 });
      if (preflight.status === "error") {
        console.error("配置不就绪，请先修复：");
        printDoctorReport(preflight);
        console.error("\n或运行：bun run dev config doctor --fix");
        process.exit(2);
      }
    } catch (e: unknown) {
      console.error(`doctor 探测失败：${e instanceof Error ? e.message : String(e)}`);
      process.exit(3);
    }
    const client = getClient(opts);
    await ensureDaemon(client);

    let requirement = opts.requirement;
    if (requirement?.startsWith("@")) {
      const path = requirement.slice(1);
      try {
        requirement = await Bun.file(path).text();
      } catch (e: unknown) {
        console.error(`读取需求文件失败：${path} - ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }

    try {
      const startOpts: {
        title?: string;
        requirement?: string;
        workflow?: string;
        repo_alias?: string;
      } = { title, requirement, workflow: opts.workflow };
      if (opts.repo) startOpts.repo_alias = opts.repo;
      const t = await client.startTask(startOpts);
      console.log(`任务已创建 [id=${t.id} workflow=${t.workflow} status=${t.status}]`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// init — 初始化（本地，不需要 daemon）
// ──────────────────────────────────────────────

program
  .command("init")
  .description("初始化 AUTOPILOT_HOME 目录结构和数据库")
  .action(async () => {
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

    const cfgPath = join(AUTOPILOT_HOME, "config.yaml");
    if (!existsSync(cfgPath)) {
      writeFileSync(cfgPath, buildConfigTemplate(), "utf-8");
      console.log(`已生成配置模板：${cfgPath}`);
    } else {
      console.log(`配置文件已存在，保留：${cfgPath}`);
    }

    // dogfood-bug8 修复：自动装 dev workflow，让用户 init 完就能跑通第一个
    // task。之前 init 只创空目录，新用户跑任何 dev task 都报"找不到工作流"。
    const devWorkflowDir = join(AUTOPILOT_HOME, "workflows", "dev");
    if (!existsSync(devWorkflowDir)) {
      try {
        const { cloneTemplate } = await import("../core/workflow-templates");
        cloneTemplate("dev", "dev");
        console.log(`已装入默认工作流：${devWorkflowDir}`);
      } catch (e: unknown) {
        console.warn(`装 dev workflow 失败（不阻塞 init）：${e instanceof Error ? e.message : String(e)}`);
        console.warn("可稍后用 web UI 或 CLI 手动克隆 dev 模板");
      }
    } else {
      console.log(`dev workflow 已存在，保留：${devWorkflowDir}`);
    }

    console.log("\n初始化完成。下一步（三选一）：");
    console.log("  » bun run dev config doctor       检查配置");
    console.log("  » bun run dev config doctor --fix 交互式配置");
    console.log("  » bun run dev dashboard           浏览器配置");
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

// 短命令跑完后强制退出（WS RPC 连接保活 event loop 会阻塞自然 exit）。
// long-running 命令（daemon run / daemon serve）通过 setInterval / signal 保活，不受影响。
program.parseAsync(process.argv).then(() => {
  // 给 ws 一个 50ms 的窗口 flush 缓冲（unref 让计时器自身不阻塞 exit）
  const t = setTimeout(() => process.exit(0), 50);
  // Bun Timer 兼容 Node Timer 的 unref（动态访问避开类型分歧）
  (t as { unref?: () => void }).unref?.();
}).catch((err: unknown) => {
  console.error("CLI 错误：", err);
  process.exit(1);
});
