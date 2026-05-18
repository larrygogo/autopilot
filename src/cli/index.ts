import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { buildConfigTemplate } from "./config-template";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { VERSION, AUTOPILOT_HOME } from "../index";
import { initDb, closeDb } from "../core/db";
import { runPendingMigrations } from "../core/migrate";
import { rebuildIndexFromManifests, rebuildManifestsFromIndex } from "../core/rebuild-index";
import { discover } from "../core/registry";
import { AutopilotClient, DEFAULT_PORT, DEFAULT_HOST } from "../client/index";
import { loadDaemonConfig } from "../core/config";
import { registerWorkflowCommands } from "./workflow";
import { registerConfigCommands, printReport as printDoctorReport } from "./config";
import { registerRequirementCommands } from "./requirements-cli";
import { runChecks as runDoctorChecks } from "../core/doctor";
import {
  readPid,
  isProcessAlive,
  isDaemonRunning,
  removePid,
  readSupervisorPid,
  isSupervisorRunning,
  removeSupervisorPid,
  readListenInfo,
  removeListenInfo,
} from "../daemon/pid";

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
  // 优先 CLI --port 覆盖；否则读 daemon.listen.json（daemon 启动时写入）；
  // 再回退到默认端口
  if (opts?.port) {
    return new AutopilotClient({ port: parseInt(opts.port, 10) });
  }
  const info = readListenInfo();
  if (info) {
    // host 用 127.0.0.1 （客户端总是本机连）
    return new AutopilotClient({ port: info.port });
  }
  return new AutopilotClient({ port: DEFAULT_PORT });
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
  .command("supervise")
  .description("前台启动 supervisor（崩溃自动重启 daemon）")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .option("-H, --host <host>", "主机", DEFAULT_HOST)
  .action(async (opts: { port: string; host: string }) => {
    const { runSupervisor } = await import("../daemon/supervisor");
    await runSupervisor({ host: opts.host, port: parseInt(opts.port, 10) });
  });

daemon
  .command("start")
  .description("后台启动 daemon（监听地址由 ~/.autopilot/config.yaml 的 daemon 段决定）")
  .option("--no-supervise", "不带 supervisor，直接跑 daemon（崩了不重启）")
  .action(async (opts: { supervise: boolean }) => {
    if (isDaemonRunning() || isSupervisorRunning()) {
      console.error("错误：daemon 或 supervisor 已在运行中。");
      process.exit(1);
    }

    const pid = await startDaemonProcess(opts.supervise);
    if (pid === null) {
      console.error("错误：daemon 启动超时。");
      process.exit(1);
    }
    const supPid = opts.supervise ? readSupervisorPid() : null;
    const supSuffix = supPid ? ` via supervisor (pid=${supPid})` : "";
    console.log(`daemon 已启动 (pid=${pid})${supSuffix}`);
    console.log(`  查看监听地址与状态：autopilot daemon status`);
  });

daemon
  .command("stop")
  .description("停止 daemon（若 supervisor 在运行则一并停止）")
  .action(async () => {
    const supPid = readSupervisorPid();
    const daemonPid = readPid();

    if (supPid && isProcessAlive(supPid)) {
      // 优先停 supervisor，它会负责通知 daemon 子进程
      process.kill(supPid, "SIGTERM");
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await Bun.sleep(200);
        if (!isProcessAlive(supPid)) {
          // Windows 下 SIGTERM 是 TerminateProcess，supervisor/daemon 都没机会跑自己的
          // cleanup handler，CLI 兜底清理 PID 文件。
          removePid();
          removeSupervisorPid();
          removeListenInfo();
          console.log("supervisor 已停止（daemon 同步退出）。");
          return;
        }
      }
      console.error("错误：supervisor 停止超时。");
      process.exit(1);
    }

    if (!daemonPid || !isProcessAlive(daemonPid)) {
      console.log("daemon 未在运行。");
      removePid();
      removeSupervisorPid();
      return;
    }

    process.kill(daemonPid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await Bun.sleep(200);
      if (!isProcessAlive(daemonPid)) {
        // 同上：Windows 强杀后 daemon 没机会清自己的 PID 文件
        removePid();
        removeListenInfo();
        console.log("daemon 已停止。");
        return;
      }
    }
    console.error("错误：daemon 停止超时。");
    process.exit(1);
  });

/**
 * 优雅停止 daemon / supervisor。返回成功与否。供 stop 和 restart 子命令复用。
 */
async function stopDaemonProcess(): Promise<boolean> {
  const supPid = readSupervisorPid();
  const daemonPid = readPid();

  if (supPid && isProcessAlive(supPid)) {
    process.kill(supPid, "SIGTERM");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await Bun.sleep(200);
      if (!isProcessAlive(supPid)) {
        // Windows 下 SIGTERM 是 TerminateProcess，cleanup handler 跑不到，CLI 兜底清。
        removePid();
        removeSupervisorPid();
        removeListenInfo();
        return true;
      }
    }
    return false;
  }

  if (!daemonPid || !isProcessAlive(daemonPid)) {
    removePid();
    removeSupervisorPid();
    return true;  // 本来就没跑
  }

  process.kill(daemonPid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    if (!isProcessAlive(daemonPid)) {
      removePid();
      removeListenInfo();
      return true;
    }
  }
  return false;
}

/**
 * 后台启动 daemon / supervisor 子进程，并等待其在 PID 文件中登记。
 *
 * 跨平台 detach 策略：
 * - Windows: `cmd /c start /b bun run <path>` —— start 派生进程后 cmd 立即退出，
 *   子进程脱离 CLI 的 Job 对象。Bun runtime 下 node:child_process 的 detached:true
 *   不可靠（CLI 仍 hold 住子进程），Bun.spawn 也无 detached 选项。
 *   两个易踩坑：
 *     1) cmd /c 后必须接单个完整命令字符串，不能拆多 args；
 *     2) 不要给 start 加 `""` 标题占位 + 引号包裹绝对路径，会触发 "Access denied"。
 *   scriptPath 是工程内路径，含空格场景未支持，提前报错让用户改用前台启动。
 * - POSIX: 标准 node:child_process.spawn + detached:true + stdio:"ignore" + unref()。
 */
/**
 * 检查 daemon 监听端口是否被占用，若是则尝试找出并强杀该进程。
 * 用于 startDaemonProcess 之前清理僵尸——daemon 异常退出时可能遗留监听端口
 * （PID 文件被清但 socket 还被占）。
 *
 * 用 spawnSync 不走 shell，避免命令注入风险。
 */
function ensurePortFree(port: number): { freed: boolean; killedPids: number[] } {
  try {
    if (process.platform === "win32") {
      // 用 PowerShell Get-NetTCPConnection 拿 PID 列表，比 netstat 解析靠谱。
      // 注意：参数走 spawnSync 数组传递，不进 shell，无注入风险。
      const psScript = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`;
      const r = nodeSpawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        { encoding: "utf-8", windowsHide: true },
      );
      const pids = (r.stdout ?? "")
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (pids.length === 0) return { freed: true, killedPids: [] };
      const killed: number[] = [];
      for (const pid of pids) {
        const k = nodeSpawnSync(
          "taskkill",
          ["/F", "/T", "/PID", String(pid)],
          { stdio: "ignore", windowsHide: true },
        );
        if (k.status === 0) killed.push(pid);
      }
      return { freed: true, killedPids: killed };
    }
    // POSIX
    const r = nodeSpawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" });
    const pids = (r.stdout ?? "")
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const killed: number[] = [];
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); killed.push(pid); } catch { /* ignore */ }
    }
    return { freed: true, killedPids: killed };
  } catch {
    return { freed: true, killedPids: [] };
  }
}

async function startDaemonProcess(supervise: boolean): Promise<number | null> {
  // 启动前清理：
  // 1. 杀残留 supervisor（不杀掉它会持续重新拉起 daemon → 新 daemon 起不来）
  // 2. 端口扫描兜底：PID 文件丢失但端口还被占的情况
  try {
    const supPid = readSupervisorPid();
    if (supPid && isProcessAlive(supPid)) {
      try {
        if (process.platform === "win32") {
          nodeSpawnSync("taskkill", ["/F", "/T", "/PID", String(supPid)], { stdio: "ignore", windowsHide: true });
        } else {
          process.kill(supPid, "SIGKILL");
        }
        console.log(`已清理残留 supervisor (pid=${supPid})`);
      } catch { /* ignore */ }
    }
    removePid();
    removeSupervisorPid();
    removeListenInfo();

    const cfg = loadDaemonConfig();
    const port = cfg.port ?? DEFAULT_PORT;
    const r = ensurePortFree(port);
    if (r.killedPids.length > 0) {
      console.log(`已清理占用端口 ${port} 的僵尸进程 (pid=${r.killedPids.join(",")})`);
      await Bun.sleep(800); // 给系统释放 socket
    }
  } catch { /* 配置加载失败时让 daemon 自己处理 */ }

  const scriptPath = supervise
    ? join(import.meta.dir, "../daemon/supervisor.ts")
    : join(import.meta.dir, "../daemon/index.ts");

  if (process.platform === "win32") {
    if (/\s/.test(scriptPath)) {
      console.error(
        `错误：daemon 脚本路径含空格（${scriptPath}），daemon start 暂不支持此场景，` +
          `请用 \`autopilot daemon run\` 前台启动。`,
      );
      return null;
    }
    // 关键：cmd /c 后必须接单个完整命令字符串；不要用 "" 标题占位 + 引号包裹路径
    // （会触发 cmd 的 "Access denied"）。Bun.spawn 在此场景下不可靠，必须用 nodeSpawn。
    const cmdStr = `start /b bun run ${scriptPath}`;
    const child = nodeSpawn("cmd.exe", ["/c", cmdStr], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } else {
    const child = nodeSpawn("bun", ["run", scriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // Windows 下 daemon 冷启动较慢（migrations + workflow discovery + 静态资源加载），
  // 给 30 秒余量；POSIX 通常 1-2 秒内就 ready。
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    const pid = readPid();
    if (pid && isProcessAlive(pid)) return pid;
  }
  return null;
}

daemon
  .command("restart")
  .description("重启 daemon（应用 ~/.autopilot/config.yaml 的最新 daemon 配置）")
  .option("--no-supervise", "不带 supervisor 重启")
  .action(async (opts: { supervise: boolean }) => {
    const wasRunning = isDaemonRunning() || isSupervisorRunning();
    if (wasRunning) {
      const ok = await stopDaemonProcess();
      if (!ok) {
        console.error("错误：停止 daemon / supervisor 超时，restart 取消。");
        process.exit(1);
      }
      console.log("daemon 已停止。");
    } else {
      console.log("daemon 未在运行，将直接启动。");
    }
    // 确保 pid 文件清理完
    await Bun.sleep(200);
    const pid = await startDaemonProcess(opts.supervise);
    if (pid === null) {
      console.error("错误：启动超时。");
      process.exit(1);
    }
    const supPid = opts.supervise ? readSupervisorPid() : null;
    const supSuffix = supPid ? ` via supervisor (pid=${supPid})` : "";
    console.log(`daemon 已启动 (pid=${pid})${supSuffix}`);
    console.log(`  查看监听地址与状态：autopilot daemon status`);
  });

daemon
  .command("status")
  .description("查看 daemon 状态")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    const pid = readPid();
    const supPid = readSupervisorPid();
    if (!pid || !isProcessAlive(pid)) {
      console.log("daemon 未在运行。");
      if (supPid && isProcessAlive(supPid)) {
        console.log(`  supervisor 还活着 (pid=${supPid})，daemon 可能正在重启中`);
      }
      return;
    }
    if (supPid && isProcessAlive(supPid)) {
      console.log(`supervisor 运行中 (pid=${supPid})`);
    }

    try {
      const client = getClient(opts);
      const status = await client.getStatus();
      const listen = readListenInfo();
      console.log(`daemon 运行中 (pid=${status.pid})`);
      if (listen) console.log(`  监听: ${listen.host}:${listen.port}`);
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
  .command("start <title>")
  .description("创建并启动任务（task ID 自动生成）")
  .option("-w, --workflow <name>", "工作流名称")
  .option("-r, --requirement <text>", "需求详情；以 @ 开头则从文件读，例如 -r @./req.md")
  .option("--repo <alias>", "绑定仓库别名（用于 req_dev 等需要仓库的工作流）")
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
  .command("rebuild-index")
  .description("从磁盘上的 task-manifest.json 重建 SQLite 索引（要求 daemon 停止）")
  .action(async () => {
    if (isDaemonRunning()) {
      console.error("错误：daemon 运行中。请先 `autopilot daemon stop` 再重建索引。");
      process.exit(1);
    }
    initDb();
    await runPendingMigrations();
    const result = rebuildIndexFromManifests();
    closeDb();
    console.log(`扫描 ${result.scanned}：新增 ${result.inserted}，更新 ${result.updated}，跳过 ${result.skipped}，失败 ${result.errors.length}`);
    for (const err of result.errors) {
      console.error(`  [${err.taskId}] ${err.message}`);
    }
    if (result.errors.length > 0) process.exit(1);
  });

task
  .command("rebuild-manifest")
  .description("从 DB 反向给缺失 manifest 的任务补一份（一次性迁移，要求 daemon 停止）")
  .action(async () => {
    if (isDaemonRunning()) {
      console.error("错误：daemon 运行中。请先 `autopilot daemon stop` 再补 manifest。");
      process.exit(1);
    }
    initDb();
    await runPendingMigrations();
    await discover();
    const result = rebuildManifestsFromIndex();
    closeDb();
    console.log(`扫描 ${result.scanned}：新增 ${result.created}，已存在 ${result.alreadyExists}，失败 ${result.errors.length}`);
    for (const err of result.errors) {
      console.error(`  [${err.taskId}] ${err.message}`);
    }
    if (result.errors.length > 0) process.exit(1);
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
      // 断线 / 重连感知：避免用户以为日志卡住其实是 daemon 没了
      client.onStateChange((state) => {
        if (state === "disconnected") {
          console.error("[WS] daemon 失联，重连中…");
        } else if (state === "connected") {
          console.error("[WS] 已连接");
        }
      });
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
// workflow — 工作流管理（list / show / create / edit / delete / export / import）
// ──────────────────────────────────────────────

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
// chat — 对话
// ──────────────────────────────────────────────

program
  .command("chat")
  .description("与 agent 对话（REPL）")
  .option("--agent <name>", "显式指定 agent")
  .option("--workflow <name>", "聚焦工作流（用于选取该工作流的 chat_agent）")
  .option("--session <id>", "续已有 session")
  .option("--title <text>", "新 session 的标题")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (opts: {
    agent?: string;
    workflow?: string;
    session?: string;
    title?: string;
    port: string;
  }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    let sessionId: string | undefined = opts.session;

    // 若续 session，打印历史
    if (sessionId) {
      try {
        const s = await client.getSession(sessionId);
        console.log(`续 session ${s.id}  agent=${s.agent}${s.workflow ? ` workflow=${s.workflow}` : ""}`);
        for (const m of s.messages) {
          const who = m.role === "user" ? "你" : "Agent";
          console.log(`${who}: ${m.content}`);
        }
        console.log("");
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    } else {
      const resolved = opts.agent ?? "(auto)";
      const hint = opts.workflow ? ` workflow=${opts.workflow}` : "";
      console.log(`开始新对话（agent=${resolved}${hint}）。输入 /exit 退出，/reset 清屏。`);
    }

    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "你 > ",
    });

    // WS 订阅：按 session_id 动态切换订阅
    let currentSub: (() => void) | null = null;
    let streaming = false;
    let streamHeaderPrinted = false;
    client.connect();

    const subscribeSession = (sid: string) => {
      if (currentSub) currentSub();
      currentSub = client.subscribe(`chat:${sid}`, (event) => {
        if (event.type === "chat:delta") {
          if (!streamHeaderPrinted) {
            process.stdout.write("\x1B[2K\rAgent > ");
            streamHeaderPrinted = true;
          }
          process.stdout.write(event.payload.delta);
        } else if (event.type === "chat:complete") {
          streaming = false;
          if (streamHeaderPrinted) {
            process.stdout.write("\n");
          } else {
            // 没收到任何 delta（可能 SDK 未开流），打印完整消息
            console.log(`Agent > ${event.payload.message.content}`);
          }
          streamHeaderPrinted = false;
          rl.prompt();
        } else if (event.type === "chat:error") {
          streaming = false;
          process.stdout.write("\x1B[2K\r");
          console.error(`错误：${event.payload.error}`);
          streamHeaderPrinted = false;
          rl.prompt();
        }
      });
    };

    if (sessionId) subscribeSession(sessionId);
    rl.prompt();

    rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) { rl.prompt(); return; }
      if (text === "/exit" || text === "/quit") { rl.close(); return; }
      if (text === "/reset") { process.stdout.write("\x1Bc"); rl.prompt(); return; }
      if (streaming) {
        console.log("（正在生成中，请稍候...）");
        return;
      }

      streaming = true;
      streamHeaderPrinted = false;
      process.stdout.write("Agent > (思考中...)\r");
      try {
        const result = await client.chat({
          message: text,
          session_id: sessionId,
          agent: opts.agent,
          workflow: opts.workflow,
          title: opts.title,
        });
        if (!sessionId) {
          sessionId = result.session_id;
          subscribeSession(sessionId);
        }
        // complete 事件通常已经打印并 rl.prompt；若 WS 没到（极端慢），兜底打印
        if (streaming) {
          streaming = false;
          if (!streamHeaderPrinted) {
            process.stdout.write("\x1B[2K\r");
            console.log(`Agent > ${result.message.content}`);
          }
          rl.prompt();
        }
      } catch (e: unknown) {
        streaming = false;
        process.stdout.write("\x1B[2K\r");
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        rl.prompt();
      }
    });

    rl.on("close", () => {
      if (currentSub) currentSub();
      client.disconnect();
      if (sessionId) console.log(`\n（session 已保存：${sessionId}）`);
      process.exit(0);
    });
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
// now — 文本卡片流（替代浏览器查看 /now）
// ──────────────────────────────────────────────

program
  .command("now")
  .description("查看当前需要关注的事（卡片流文本视图）")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    try {
      const cards = await client.listNowCards();
      if (cards.length === 0) {
        console.log("🎉 没有需要关注的事。");
        return;
      }

      // 按优先级 + created_at 排序（与后端一致）
      const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
      cards.sort((a, b) => {
        const dp = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
        if (dp !== 0) return dp;
        return a.created_at - b.created_at;
      });

      // 计算列宽
      const nowSec = Math.floor(Date.now() / 1000);
      const rows = cards.map((c) => {
        const waitedSec = Math.max(0, nowSec - c.created_at);
        const wait = waitedSec < 60 ? `${waitedSec}s`
          : waitedSec < 3600 ? `${Math.floor(waitedSec / 60)}min`
          : `${Math.floor(waitedSec / 3600)}h`;
        const actionsLine = c.actions.map((a) => a.label).join(" / ");
        return {
          prio: c.priority,
          title: c.title,
          subtitle: c.subtitle,
          wait,
          actions: actionsLine,
        };
      });

      const widths = {
        prio: 4,
        title: Math.max(8, ...rows.map((r) => r.title.length)),
        wait: Math.max(6, ...rows.map((r) => r.wait.length)),
      };
      // 截断 title 防过宽
      const maxTitle = Math.min(widths.title, 60);

      console.log(
        `${"PRIO".padEnd(widths.prio)}  ${"TITLE".padEnd(maxTitle)}  ${"WAIT".padEnd(widths.wait)}  ACTIONS`,
      );
      console.log(
        `${"-".repeat(widths.prio)}  ${"-".repeat(maxTitle)}  ${"-".repeat(widths.wait)}  -------`,
      );
      for (const r of rows) {
        const title = r.title.length > maxTitle ? r.title.slice(0, maxTitle - 1) + "…" : r.title;
        console.log(
          `${r.prio.padEnd(widths.prio)}  ${title.padEnd(maxTitle)}  ${r.wait.padEnd(widths.wait)}  ${r.actions}`,
        );
      }
      console.log(`\n共 ${cards.length} 项。`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

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

    const cfgPath = join(AUTOPILOT_HOME, "config.yaml");
    if (!existsSync(cfgPath)) {
      writeFileSync(cfgPath, buildConfigTemplate(), "utf-8");
      console.log(`已生成配置模板：${cfgPath}`);
    } else {
      console.log(`配置文件已存在，保留：${cfgPath}`);
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
