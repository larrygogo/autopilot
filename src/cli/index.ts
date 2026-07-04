import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, sep } from "path";
import { buildConfigTemplate } from "./config-template";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { VERSION, AUTOPILOT_HOME } from "../index";
import { notificationIntentToLabel } from "../client/notification-intent";
import { localizeLogLine } from "../core/logger";
import { initDb, closeDb } from "../core/db";
import { runPendingMigrations, scaffoldMigration } from "../core/migrate";
import { rebuildIndexFromManifests, rebuildManifestsFromIndex } from "../core/rebuild-index";
import { getTaskSandbox } from "../core/sandbox";
import { discover } from "../core/workflow/registry";
import { AutopilotClient, DEFAULT_PORT, DEFAULT_HOST } from "../client/index";
import { loadDaemonConfig } from "../core/config";
import { registerWorkflowCommands } from "./workflow";
import { registerConfigCommands, printReport as printDoctorReport } from "./config";
import { ensureSecretKey, setApiKey as coreSetApiKey, deleteApiKey as coreDeleteApiKey, listApiKeys as coreListApiKeys } from "../core/api-keys";
import {
  listProviders as coreListProviders,
  createProvider as coreCreateProvider,
  deleteProvider as coreDeleteProvider,
  getProviderByName as coreGetProviderByName,
  getProviderById as coreGetProviderById,
  setProviderCliStatus as coreSetProviderCliStatus,
  type ProviderType,
} from "../core/providers";
import { listWorkflowsUsingProvider } from "../core/workflow/registry";
import { probeCli } from "../agents/cli-status";
import { loadLifecycleConfig, saveLifecycleAgent } from "../core/config";
import { registerRequirementCommands } from "./requirements-cli";
import { registerProjectCommands } from "./project";
import { registerWorkspaceCommands } from "./workspace";
import { registerSelfhostedCommands } from "./selfhosted";
import { runChecks as runDoctorChecks, hasTaskStartBlocker } from "../core/doctor";
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
  writeRestartFlag,
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

/**
 * 端口解析优先级（dogfood-bug22 / bug24）：
 *   1. 用户显式 --port 非默认值 → 覆盖（跨 HOME 场景）
 *   2. daemon.listen.json → daemon 启动时写入的真实端口
 *   3. DEFAULT_PORT 兜底
 *
 * 之前 commander 永远把 String(DEFAULT_PORT) 注入 opts.port → opts.port
 * 永远 truthy → readListenInfo 永远走不到。客户改 config.json.daemon.port
 * = 16180 后跑 daemon status / tui / dashboard 都连 6180 → 错的 daemon。
 */
function resolvePort(opts?: { port?: string }): number {
  const explicitPort =
    opts?.port && parseInt(opts.port, 10) !== DEFAULT_PORT
      ? parseInt(opts.port, 10)
      : null;
  const info = readListenInfo();
  return explicitPort ?? info?.port ?? DEFAULT_PORT;
}

function getClient(opts?: { port?: string }): AutopilotClient {
  return new AutopilotClient({ port: resolvePort(opts) });
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
  .description("前台启动 daemon（缺省时监听地址由 config.json 的 daemon 段决定）")
  .option("-p, --port <port>", "端口")
  .option("-H, --host <host>", "主机")
  .option("--insecure-no-auth", "明知风险：对外暴露且不设鉴权时仍然启动")
  .action(async (opts: { port?: string; host?: string; insecureNoAuth?: boolean }) => {
    const { startDaemon } = await import("../daemon/index");
    // 不给 CLI 默认值：显式参数 > env > config.json > 内置默认 的优先级链由
    // startDaemon 统一裁决；CLI 默认 127.0.0.1 会掩盖 config 的 host 配置，
    // 导致 daemon run 与 daemon start 监听地址不一致（2026-06-10 事故排查假象）
    await startDaemon({
      host: opts.host,
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      insecureNoAuth: opts.insecureNoAuth,
    });
    // startDaemon resolve ≠ daemon 结束（server/定时器还在跑，退出走它自己的
    // SIGINT/SIGTERM handler 里的 process.exit）。这里必须挂起，否则文件末尾
    // parseAsync().then() 的"短命令 50ms 强制退出"兜底会把前台 daemon 杀掉。
    await new Promise(() => {});
  });

daemon
  .command("supervise")
  .description("前台启动 supervisor（崩溃自动重启 daemon；缺省监听地址由 config.json 决定）")
  .option("-p, --port <port>", "端口")
  .option("-H, --host <host>", "主机")
  .action(async (opts: { port?: string; host?: string }) => {
    const { runSupervisor } = await import("../daemon/supervisor");
    await runSupervisor({
      host: opts.host,
      port: opts.port ? parseInt(opts.port, 10) : undefined,
    });
  });

daemon
  .command("start")
  .description("后台启动 daemon（监听地址由 ~/.autopilot/config.json 的 daemon 段决定）")
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

/**
 * 优先尝试优雅停机：RPC daemon.shutdown → daemon 自己 server.stop() 关闭全部 socket
 * 后 exit 0 → supervisor classifyExit=exit_clean 一并退出。
 * 动机（2026-06-10 事故）：Windows 下 SIGTERM 是 TerminateProcess 硬杀，daemon 死时
 * 若有活跃 WS/HTTP 连接，内核可能留下无主 zombie LISTEN socket（CLOSE_WAIT 无超时
 * 永不自愈），端口直到重启机器都不可用。成功返回 true；daemon 不可达/超时返回 false
 * 由调用方走 SIGTERM 兜底。
 */
async function tryGracefulShutdown(): Promise<boolean> {
  const info = readListenInfo();
  if (!info) return false;
  const supPid = readSupervisorPid();
  const daemonPid = readPid();
  if (!daemonPid || !isProcessAlive(daemonPid)) return false;

  const client = new AutopilotClient({ host: info.host, port: info.port });
  try {
    const r = await client.shutdownDaemon();
    if (!r.ok) return false;
  } catch {
    return false;
  } finally {
    try { client.close(); } catch { /* ignore */ }
  }
  // 等 daemon（+supervisor，如有）真正退出
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    const dDead = !isProcessAlive(daemonPid);
    const sDead = !supPid || !isProcessAlive(supPid);
    if (dDead && sDead) {
      removePid();
      removeSupervisorPid();
      removeListenInfo();
      return true;
    }
  }
  return false;
}

daemon
  .command("stop")
  .description("停止 daemon（若 supervisor 在运行则一并停止）")
  .action(async () => {
    if (await tryGracefulShutdown()) {
      console.log("daemon 已优雅停止。");
      return;
    }

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
  if (await tryGracefulShutdown()) return true;

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
  .description("重启 daemon（应用 ~/.autopilot/config.json 的最新 daemon 配置）")
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
      // 主动重启标志：新 daemon 据此对 running_* task 自动 respawn（关旧 phase
      // event + 立即重跑），而不是标 dangling 等用户 / 等 watcher 卡死判定兜底
      writeRestartFlag();
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
      // 版本同时显示 git_sha + ISO 启动时间（dogfood-bug13）：客户做完
      // daemon restart 后能从 CLI 一眼 verify"现在跑的真是新代码"，跟
      // web Settings 的「Daemon 信息」卡片对齐。
      const sha = (status as { git_sha?: string }).git_sha;
      const startedAt = (status as { started_at_iso?: string }).started_at_iso;
      console.log(`  版本: ${status.version}${sha ? ` · ${sha}` : ""}`);
      if (startedAt) console.log(`  启动于: ${new Date(startedAt).toLocaleString()}`);
      console.log(`  运行时间: ${status.uptime}s`);
      const update = (status as { update?: { status?: string } }).update;
      if (update?.status === "behind") {
        console.log(`  ⚠ 有更新可用：本地落后远端，跑 \`git pull\` 升级（必要时 bun run build:web）`);
      }
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
  .option("--repo <alias>", "绑定 workspace 别名（用于 dev 等需要 workspace 的工作流）")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (title: string, opts: { workflow?: string; requirement?: string; repo?: string; port: string }) => {
    try {
      const preflight = await runDoctorChecks({ level: 2 });
      if (hasTaskStartBlocker(preflight)) {
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
        workspace_alias?: string;
      } = { title, requirement, workflow: opts.workflow };
      if (opts.repo) startOpts.workspace_alias = opts.repo;
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
  .option("--json", "原始 JSON 输出（脚本友好）")
  .action(async (taskId: string | undefined, opts: { port: string; json?: boolean }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    if (taskId) {
      try {
        const t = await client.getTask(taskId);
        if (opts.json) {
          console.log(JSON.stringify(t, null, 2));
          return;
        }
        // 默认 human-readable 输出（dogfood-bug14）：之前 task status <id>
        // 是裸 JSON dump，跟无 id 的表格视图风格不一致。客户看完跑完的
        // task 应该看到清晰字段而不是手工读 JSON。
        const tt = t as Record<string, unknown>;
        const fields: Array<[string, unknown]> = [
          ["ID", tt.id],
          ["标题", tt.title],
          ["工作流", tt.workflow],
          ["状态", tt.status],
          ["创建于", tt.created_at],
          ["启动于", tt.started_at ?? "(未启动)"],
          ["更新于", tt.updated_at],
          ["失败次数", tt.failure_count ?? 0],
          ["PR", tt.pr_url ?? "(无)"],
          ["关联需求", tt.requirement_id ?? "(无)"],
          ["父任务", tt.parent_task_id ?? "(无)"],
        ];
        // 终态任务追加「为什么停在这」：取消/失败原因 + 驳回计数（dogfood：req-008 自动止损不可见）
        if (["done", "failed", "cancelled", "canceled"].includes(String(tt.status))) {
          try {
            const outcome = await client.getTaskOutcome(taskId);
            if (outcome.terminal_reason) {
              fields.push(["终止原因", outcome.terminal_reason]);
            }
            if (outcome.rejection_counts && Object.keys(outcome.rejection_counts).length > 0) {
              fields.push([
                "驳回计数",
                Object.entries(outcome.rejection_counts).map(([k, v]) => `${k} ×${v}`).join(" · "),
              ]);
            }
          } catch {
            // outcome 拉不到不阻塞基础字段输出
          }
        }
        const labelWidth = Math.max(...fields.map(([k]) => k.length));
        for (const [k, v] of fields) {
          console.log(`  ${k.padEnd(labelWidth)}  ${v}`);
        }
        console.log("");
        console.log(`Workspace: ${getTaskSandbox(String(tt.id))}${sep}`);
        console.log(`日志：autopilot task logs ${tt.id}`);
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
  .command("send-prompt <task-id> <prompt>")
  .description("运行中 task 追加 prompt（spec §3.8：running→排队 / awaiting→answerPending / 终态拒绝）")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (taskId: string, prompt: string, opts: { port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);
    try {
      const r = await client.sendTaskPrompt(taskId, prompt);
      console.log(`prompt 已${r.mode === "queued" ? "排队" : "投递"} [task=${taskId} mode=${r.mode}]`);
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
      // created_at 是 DB 落的 UTC（datetime('now')）→ 行首转本地显示
      console.log(localizeLogLine(`${log.created_at}  ${log.from_status ?? "-"} → ${log.to_status}  [${log.trigger_name ?? "-"}]  ${log.note ?? ""}`));
    }

    // 末尾给客户指明 agent trace 位置 —— task logs 只显示状态机转换，客户
    // 跑完最想看的"agent 写了啥 / 评审什么意见"在 workspace 里。
    if (!opts.follow) {
      const wsRoot = getTaskSandbox(taskId) + sep;
      console.log("");
      console.log(`Agent trace + phase 产物：${wsRoot}<NN-phase>${sep}agent-trace.md`);
      console.log(`实时跟踪状态：autopilot task logs ${taskId} --follow`);
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
          // log:entry.message 是 UTC 格式行（Web 自己转本地）；CLI 跟踪时行首转本地
          console.log(localizeLogLine(event.payload.message));
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
// run — 一句话发包（spec §3.7 ad-hoc 入口）
// ──────────────────────────────────────────────

program
  .command("run <prompt>")
  .description("一句话发包：跳过项目/需求/工作流选择，直接跑 ad-hoc 工作流")
  .option("-c, --workspace <alias>", "绑定 workspace 别名（启用 git 沙盒：独立 clone）")
  .option("-w, --workflow <name>", "覆盖默认 ad-hoc workflow")
  .option("--no-follow", "不跟踪实时日志，仅返回 task id")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (prompt: string, opts: { workspace?: string; workflow?: string; follow?: boolean; port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);

    let task;
    try {
      task = await client.startAdHocTask({
        prompt,
        workspace_alias: opts.workspace,
        workflow: opts.workflow,
      });
    } catch (e: unknown) {
      console.error(`启动失败：${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }

    console.log(`任务已创建 [id=${task.id} workflow=${task.workflow} status=${task.status}]`);

    // 默认跟随实时日志（--no-follow 跳过）
    if (opts.follow === false) {
      console.log(`查看日志：autopilot task logs ${task.id} --follow`);
      return;
    }

    client.connect();
    client.onStateChange((state) => {
      if (state === "disconnected") console.error("[WS] daemon 失联，重连中…");
    });
    client.subscribe(`log:${task.id}`, (event) => {
      if (event.type === "log:entry") console.log(event.payload.message);
    });
    let finalStatus: string | null = null;
    client.subscribe(`task:${task.id}`, (event) => {
      if (event.type === "task:transition") {
        const to = event.payload.to;
        console.log(`[状态] ${event.payload.from} → ${to} (${event.payload.trigger})`);
        if (to === "done") finalStatus = "done";
        else if (to === "failed" || to === "cancelled") finalStatus = to;
      }
    });

    // 轮询：终态时退出
    const exitCode = await new Promise<number>((resolve) => {
      const timer = setInterval(() => {
        if (finalStatus === "done") { clearInterval(timer); resolve(0); }
        else if (finalStatus === "failed" || finalStatus === "cancelled") { clearInterval(timer); resolve(1); }
      }, 500);
    });
    process.exit(exitCode);
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
registerSelfhostedCommands(program);
registerProjectCommands(program);
registerWorkspaceCommands(program);

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
      startTui({ port: resolvePort(opts) });
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
    // 优先 listen.json（客户改端口后跟随）；显式 --port 非默认覆盖
    const port = resolvePort(opts);
    const url = `http://${DEFAULT_HOST}:${port}`;
    console.log(`打开浏览器：${url}`);
    // headless / CI / 测试环境：只打印 URL，不真正拉起浏览器，
    // 避免在 `bun test`（spawn 本命令验证端口解析）时刷开真实浏览器 tab。
    if (process.env.AUTOPILOT_NO_BROWSER || process.env.CI) {
      console.log("（已设 AUTOPILOT_NO_BROWSER/CI，跳过自动打开，请手动访问上面的 URL）");
      return;
    }
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
// notifications — 事件型通知流（list / read / dismiss）
// ──────────────────────────────────────────────

async function runNotificationsList(opts: {
  port: string;
  unread?: boolean;
  json?: boolean;
  limit?: string;
}): Promise<void> {
  const client = getClient(opts);
  await ensureDaemon(client);
  try {
    const limit = opts.limit ? Math.max(1, parseInt(opts.limit, 10) || 50) : 50;
    const { items } = await client.listNotifications({
      limit,
      unread_only: opts.unread === true,
    });
    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      console.log(opts.unread ? "🎉 没有未读通知。" : "🎉 没有通知。");
      return;
    }
    const ago = (ms: number) => {
      const s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}min`;
      if (s < 86400) return `${Math.floor(s / 3600)}h`;
      return `${Math.floor(s / 86400)}d`;
    };
    const nowMs = Date.now();
    const rows = items.map((n) => ({
      id: String(n.id),
      sev: n.severity.toUpperCase(),
      read: n.read_at === null ? "●" : " ",
      title: n.context?.requirement_title ? `${n.title} · ${n.context.requirement_title}` : `${n.title}${n.body ? ` · ${n.body}` : ""}`,
      when: ago(nowMs - n.created_at),
      actions: n.actions.map((a) => notificationIntentToLabel(a.intent)).join(" / "),
    }));
    const wId = Math.max(2, ...rows.map((r) => r.id.length));
    const wSev = Math.max(6, ...rows.map((r) => r.sev.length));
    const maxTitle = Math.min(Math.max(8, ...rows.map((r) => r.title.length)), 60);
    const wWhen = Math.max(4, ...rows.map((r) => r.when.length));
    console.log(
      ` ${"ID".padEnd(wId)}  ${"SEV".padEnd(wSev)}  ${"TITLE".padEnd(maxTitle)}  ${"AGE".padEnd(wWhen)}  ACTIONS`,
    );
    console.log(
      `--${"-".repeat(wId)}  ${"-".repeat(wSev)}  ${"-".repeat(maxTitle)}  ${"-".repeat(wWhen)}  -------`,
    );
    for (const r of rows) {
      const title = r.title.length > maxTitle ? r.title.slice(0, maxTitle - 1) + "…" : r.title;
      console.log(
        `${r.read}${r.id.padEnd(wId)}  ${r.sev.padEnd(wSev)}  ${title.padEnd(maxTitle)}  ${r.when.padEnd(wWhen)}  ${r.actions}`,
      );
    }
    console.log(`\n共 ${items.length} 条（● = 未读）。`);
  } catch (e: unknown) {
    console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const notificationsCmd = program
  .command("notifications")
  .description("通知（事件型通知流：任务终态 / 等待决策 / 异常）");

notificationsCmd
  .command("list", { isDefault: true })
  .description("列出通知（默认最近 50 条，不含已删除）")
  .option("--unread", "只看未读")
  .option("--json", "JSON 输出")
  .option("--limit <n>", "最多返回条数", "50")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(runNotificationsList);

notificationsCmd
  .command("read [ids...]")
  .description("标记已读（传通知 id 列表，或 --all 全部已读）")
  .option("--all", "全部标为已读")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (ids: string[], opts: { port: string; all?: boolean }) => {
    const client = getClient(opts);
    await ensureDaemon(client);
    try {
      if (opts.all) {
        const { updated } = await client.markAllNotificationsRead();
        console.log(`已读 ${updated} 条。`);
        return;
      }
      const numeric = ids.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
      if (numeric.length === 0) {
        console.error("用法：autopilot notifications read <id...> 或 --all");
        process.exit(1);
      }
      const { updated } = await client.markNotificationsRead(numeric);
      console.log(`已读 ${updated} 条。`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

notificationsCmd
  .command("dismiss <id>")
  .description("删除（隐藏）一条通知")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (id: string, opts: { port: string }) => {
    const client = getClient(opts);
    await ensureDaemon(client);
    try {
      const numeric = parseInt(id, 10);
      if (!Number.isFinite(numeric)) {
        console.error("id 必须是数字");
        process.exit(1);
      }
      await client.dismissNotification(numeric);
      console.log(`已删除通知 ${numeric}。`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

// 旧 `autopilot now` —— 隐藏 deprecated 别名，指向 notifications list --unread（下版删除）
program
  .command("now", { hidden: true })
  .description("[deprecated] 改用 autopilot notifications")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    console.error("提示：`autopilot now` 已废弃，请改用 `autopilot notifications`（本别名下版移除）。\n");
    await runNotificationsList({ port: opts.port, unread: true });
  });

// ──────────────────────────────────────────────
// start — 快捷创建任务（task start 的顶层别名）
// ──────────────────────────────────────────────

program
  .command("start <title>")
  .description("快捷创建并启动任务（task start 的顶层别名）")
  .option("-w, --workflow <name>", "工作流名称")
  .option("-r, --requirement <text>", "需求详情；以 @ 开头则从文件读")
  .option("--repo <alias>", "绑定 workspace 别名")
  .option("-p, --port <port>", "daemon 端口", String(DEFAULT_PORT))
  .action(async (title: string, opts: { workflow?: string; requirement?: string; repo?: string; port: string }) => {
    try {
      const preflight = await runDoctorChecks({ level: 2 });
      if (hasTaskStartBlocker(preflight)) {
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
        workspace_alias?: string;
      } = { title, requirement, workflow: opts.workflow };
      if (opts.repo) startOpts.workspace_alias = opts.repo;
      const t = await client.startTask(startOpts);
      console.log(`任务已创建 [id=${t.id} workflow=${t.workflow} status=${t.status}]`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// key — API 密钥管理（本地，不需要 daemon）
// ──────────────────────────────────────────────

const key = program.command("key").alias("apikey").description("API 密钥管理");

key
  .command("set <provider>")
  .description("设置 API 密钥（交互式输入，不落 shell history）")
  .option("--from-env <varName>", "从环境变量读取密钥")
  .action(async (provider: string, opts: { fromEnv?: string }) => {
    initDb();
    await runPendingMigrations();

    let rawKey: string;

    if (opts.fromEnv) {
      // 从环境变量读取
      const envValue = process.env[opts.fromEnv];
      if (!envValue) {
        console.error(`错误：环境变量 ${opts.fromEnv} 未设置或为空`);
        process.exit(1);
      }
      rawKey = envValue;
    } else {
      // 交互式输入（无回显）
      process.stdout.write(`请输入 ${provider} 的 API key: `);
      rawKey = await readLineNoEcho();
      console.log(); // 换行
      if (!rawKey.trim()) {
        console.error("错误：API key 不能为空");
        process.exit(1);
      }
    }

    try {
      await coreSetApiKey(provider, rawKey);
      console.log(`✓ ${provider} 的 API key 已保存`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

key
  .command("list")
  .description("列出已配置的 API 密钥（脱敏显示）")
  .action(async () => {
    initDb();
    await runPendingMigrations();
    const keys = coreListApiKeys();
    if (keys.length === 0) {
      console.log("暂无已配置的 API 密钥。");
      console.log("使用 `autopilot key set <provider>` 添加密钥。");
      return;
    }
    console.log("已配置的 API 密钥：\n");
    const maxNameLen = Math.max(...keys.map((k) => k.provider.length));
    for (const k of keys) {
      const name = k.provider.padEnd(maxNameLen);
      const source = k.source === "env" ? " (环境变量)" : "";
      const updated = k.updated_at ? ` [${k.updated_at}]` : "";
      console.log(`  ${name}  ${k.key_hint}${source}${updated}`);
    }
  });

key
  .command("delete <provider>")
  .description("删除 API 密钥")
  .action(async (provider: string) => {
    initDb();
    await runPendingMigrations();
    try {
      coreDeleteApiKey(provider);
      console.log(`✓ ${provider} 的 API key 已删除`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

// ── provider 条目管理（条目化重构 P1；CLI 一等公民，core 直连不经 daemon）──

const provider = program.command("provider").description("模型供应商条目管理（CLI / API 单类型实例）");

provider
  .command("list")
  .description("列出 provider 条目")
  .action(async () => {
    initDb();
    await runPendingMigrations();
    const list = coreListProviders();
    if (list.length === 0) {
      console.log("暂无 provider 条目。用 `autopilot provider add <name> --type cli|api` 添加。");
      return;
    }
    const nameW = Math.max(...list.map((p) => p.name.length), 4);
    console.log(`${"NAME".padEnd(nameW)}  TYPE  SUBTYPE         STATUS`);
    for (const p of list) {
      const status = p.type === "cli"
        ? (p.cli_status === "ok" ? "就绪" : p.cli_status === "missing" ? "本地不支持" : "未检测")
        : (p.default_model ? `model=${p.default_model}` : "—");
      const en = p.enabled === 0 ? " (禁用)" : "";
      console.log(`${p.name.padEnd(nameW)}  ${p.type.padEnd(4)}  ${p.subtype.padEnd(14)}  ${status}${en}`);
    }
  });

provider
  .command("add <name>")
  .description("添加 provider 条目")
  .requiredOption("--type <type>", "类型：cli | api")
  .option("--subtype <subtype>", "cli: claude|codex|gemini|custom；api: openai-compat（默认）/anthropic/openai/google")
  .option("--display <name>", "显示名")
  .option("--base-url <url>", "API 端点（api 类型）")
  .option("--model <model>", "默认模型")
  .option("--cli-bin <bin>", "自定义 CLI 二进制（subtype=custom）")
  .option("--env-key <NAME>", "API 密钥环境变量名")
  .action(async (name: string, opts: {
    type: string; subtype?: string; display?: string; baseUrl?: string; model?: string; cliBin?: string; envKey?: string;
  }) => {
    initDb();
    await runPendingMigrations();
    const type = opts.type as ProviderType;
    if (type !== "cli" && type !== "api") {
      console.error("错误：--type 需为 cli 或 api");
      process.exit(1);
    }
    const subtype = opts.subtype ?? (type === "cli" ? "claude" : "openai-compat");
    try {
      const entry = coreCreateProvider({
        name,
        display_name: opts.display ?? name,
        type,
        subtype,
        cli_bin: opts.cliBin ?? null,
        base_url: opts.baseUrl ?? null,
        env_key_name: opts.envKey ?? null,
        default_model: opts.model ?? null,
      });
      if (type === "cli") {
        const probe = await probeCli(subtype, entry.cli_bin ?? undefined);
        coreSetProviderCliStatus(entry.id, probe.status, probe.version ?? null);
        console.log(`✓ 已添加 ${name}（${entry.id}）；本地 CLI：${probe.status === "ok" ? `就绪 ${probe.version ?? ""}` : probe.status === "missing" ? "本地不支持（未安装）" : "未知"}`);
      } else {
        console.log(`✓ 已添加 ${name}（${entry.id}）；API 密钥用 \`autopilot key set ${name}\` 配置`);
      }
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

provider
  .command("remove <idOrName>")
  .description("删除 provider 条目（被工作流引用则拒删，--force 强删）")
  .option("--force", "忽略工作流引用强制删除")
  .action(async (idOrName: string, opts: { force?: boolean }) => {
    initDb();
    await runPendingMigrations();
    const entry = idOrName.startsWith("prov-") ? coreGetProviderById(idOrName) : coreGetProviderByName(idOrName);
    if (!entry) {
      console.error(`错误：找不到 provider 条目：${idOrName}`);
      process.exit(1);
    }
    // 加载工作流到 registry（core 直连上下文未自动 discover），否则引用守卫看到空 registry
    await discover();
    const refs = listWorkflowsUsingProvider(entry.name);
    if (refs.length > 0 && !opts.force) {
      console.error(`错误：provider「${entry.name}」被工作流引用，删除会让它们无法使用：`);
      for (const r of refs) console.error(`  - ${r.workflow}（${r.phases.join(", ")}）`);
      console.error("先改这些工作流的 provider，或加 --force 强删。");
      process.exit(1);
    }
    coreDeleteProvider(entry.id);
    console.log(`✓ 已删除 provider 条目：${entry.name}`);
  });

// ── 生命周期 agent 配置（lifecycle: 段；P1 仅 clarify。core 直连，daemon 实时读盘生效）──

const lifecycle = program.command("lifecycle").description("平台生命周期 agent 配置（澄清等，全局默认）");

lifecycle
  .command("list")
  .description("查看生命周期 agent 配置（用户 override，未列字段走内置默认）")
  .action(async () => {
    initDb();
    await runPendingMigrations();
    const cfg = loadLifecycleConfig();
    console.log("生命周期 agent（全局默认；未列字段走内置默认）：\n");
    const labels: Record<string, string> = {
      clarify: "澄清 / 一句话建需求 / AI 建工作流共用",
      fix: "驳回 / CI 失败后的修复回路 __fix（含修复取向人设）",
    };
    for (const name of ["clarify", "fix"] as const) {
      const c = cfg[name] ?? {};
      if (Object.keys(c).length === 0) {
        console.log(`  ${name}（${labels[name]}）：未配置，走内置默认`);
      } else {
        console.log(`  ${name}（${labels[name]}，用户 override）：`);
        for (const [k, v] of Object.entries(c)) {
          const val = typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v;
          console.log(`    ${k}: ${val}`);
        }
      }
    }
    console.log("\n未列字段走内置默认；用 `autopilot lifecycle set <clarify|fix> --system-prompt …` 配置（clarify 实时、fix 需 daemon restart 生效）。");
  });

lifecycle
  .command("set <name>")
  .description("设置生命周期 agent（clarify | fix）；未给的字段保留")
  .option("--provider <name>", "provider（如 kimi-code）")
  .option("--model <model>", "默认模型")
  .option("--max-turns <n>", "最大轮数", (v) => parseInt(v, 10))
  .option("--permission-mode <mode>", "权限模式（default/bypassPermissions/cautious/...）")
  .option("--system-prompt <text>", "系统提示词")
  .option("--system-prompt-file <path>", "从文件读系统提示词")
  .action(async (name: string, opts: {
    provider?: string; model?: string; maxTurns?: number; permissionMode?: string; systemPrompt?: string; systemPromptFile?: string;
  }) => {
    if (name !== "clarify" && name !== "fix") { console.error("仅支持 clarify | fix"); process.exit(1); }
    initDb();
    await runPendingMigrations();
    // 在现有 override 上叠加（未给的字段保留）
    const cur = (loadLifecycleConfig()[name] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...cur };
    if (opts.provider !== undefined) next.provider = opts.provider;
    if (opts.model !== undefined) next.model = opts.model;
    if (opts.maxTurns !== undefined && !Number.isNaN(opts.maxTurns)) next.max_turns = opts.maxTurns;
    if (opts.permissionMode !== undefined) next.permission_mode = opts.permissionMode;
    if (opts.systemPromptFile) {
      const { readFileSync } = await import("fs");
      next.system_prompt = readFileSync(opts.systemPromptFile, "utf-8");
    } else if (opts.systemPrompt !== undefined) {
      next.system_prompt = opts.systemPrompt;
    }
    try {
      saveLifecycleAgent(name, Object.keys(next).length ? next : null);
      const apply = name === "fix" ? "daemon restart 后生效" : "daemon 实时读盘，下次澄清生效";
      console.log(`✓ 已保存 lifecycle.${name}（${Object.keys(next).join(", ") || "空=回退默认"}）。${apply}。`);
    } catch (e: unknown) {
      console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

lifecycle
  .command("reset <name>")
  .description("清除生命周期 agent 配置（clarify | fix），回退内置默认")
  .action(async (name: string) => {
    if (name !== "clarify" && name !== "fix") { console.error("仅支持 clarify | fix"); process.exit(1); }
    initDb();
    await runPendingMigrations();
    saveLifecycleAgent(name, null);
    console.log(`✓ 已重置 lifecycle.${name}，回退内置默认。`);
  });

/**
 * 无回显读取一行输入（用于密码/密钥输入）。
 *
 * 使用 readline 模块 + 静默 output stream 实现跨平台隐藏输入：
 * - Windows 终端通常 stdin.setRawMode 为 undefined，旧实现无法隐藏输入
 * - readline 配合 muted output 在所有平台都能正确隐藏回显
 */
async function readLineNoEcho(): Promise<string> {
  const rl = await import("readline");
  const { Writable } = await import("stream");

  // 静默输出流：所有写入都丢弃（阻止 readline 回显用户输入）
  const mutedOutput = new Writable({
    write(_chunk: unknown, _encoding: string, callback: () => void) {
      callback();
    },
  });

  const iface = rl.createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });

  return new Promise((resolve, reject) => {
    iface.question("", (answer) => {
      iface.close();
      resolve(answer);
    });

    // 处理 Ctrl+C
    iface.on("close", () => {
      // 如果 question callback 未触发就 close 了（用户按 Ctrl+C），
      // readline 会正常关闭，question callback 不会被调用
    });
    process.once("SIGINT", () => {
      iface.close();
      reject(new Error("用户中断"));
    });
  });
}

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
    // 生成 API 密钥加密文件（幂等，已存在则跳过）
    try {
      await ensureSecretKey();
    } catch (e: unknown) {
      console.warn(`生成 secret.key 失败（不阻塞 init）：${e instanceof Error ? e.message : String(e)}`);
    }

    initDb();
    // dogfood-bug19 修复：init 必须跑全部 migrations，否则只创出 SCHEMA 里的
    // 基础表（tasks/task_logs），后续 18 条迁移加的 projects/codebases/
    // requirements/workflows 全缺。客户 init 完跑 dashboard 创
    // project 立即报 "no such table: projects"。
    const migrated = await runPendingMigrations();
    if (migrated > 0) {
      console.log(`已初始化数据库：${join(AUTOPILOT_HOME, "runtime", "workflow.db")}（应用 ${migrated} 条迁移）`);
    } else {
      console.log(`已初始化数据库：${join(AUTOPILOT_HOME, "runtime", "workflow.db")}`);
    }

    // 自动迁移 config.yaml → config.json（存量用户升级路径）
    const { ensureJsonConfig } = await import("../core/config");
    ensureJsonConfig();

    const cfgPath = join(AUTOPILOT_HOME, "config.json");
    if (!existsSync(cfgPath)) {
      writeFileSync(cfgPath, buildConfigTemplate(), "utf-8");
      console.log(`已生成配置模板：${cfgPath}`);
    } else {
      console.log(`配置文件已存在，保留：${cfgPath}`);
    }

    // 自动装默认工作流 dev + ad-hoc，让新用户 init 完就能跑通第一个 task。
    // Step5b：种成 **DB 模板行**（kind=template，spec_json 真相），不再拷文件——DB 是默认安装形态。
    // 幂等：磁盘已有 file 副本 / DB 已有同名 → skip（存量用户双轨不动，新装走 DB 模板）。
    try {
      const { seedTemplateWorkflow } = await import("../core/workflow/templates");
      for (const name of ["dev", "ad-hoc"]) {
        const r = seedTemplateWorkflow(name);
        if (r === "seeded") console.log(`已装入默认工作流（DB 模板）：${name}`);
        else if (r === "exists") console.log(`${name} 工作流已存在，保留`);
        else if (r === "has-ts") console.warn(`${name} 模板含 workflow.ts，不能种成 DB 模板，跳过`);
        else console.warn(`找不到 ${name} 模板，跳过（可稍后手动导入）`);
      }
    } catch (e: unknown) {
      console.warn(`装默认工作流失败（不阻塞 init）：${e instanceof Error ? e.message : String(e)}`);
      console.warn("可稍后用 web UI 或 CLI 手动导入 dev / ad-hoc 模板");
    }

    // Phase 5：provider 就绪提醒（静态引导——脚手架与运行前置分开，不在 init 里探测/拒绝）。
    // 运行时（澄清 / 入队 / 起任务）会校验「有可用 provider」，无则提前拒并指引；第一个配好的自动设默认。
    console.log("\n⚠ autopilot 需要至少一个可用 AI 供应商（CLI 登录 或 填 API key）才能执行任务：");
    console.log("    » CLI 登录（推荐）：claude login / codex login / gemini auth login");
    console.log("    » 填 API key：     autopilot key set <provider>");
    console.log("    » Web 配置：       autopilot dashboard → 设置 → 提供商");

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
// migrate — 迁移工具（new = 自动取号生成骨架，防撞号）
// ──────────────────────────────────────────────

const migrateCmd = program.command("migrate").description("数据库迁移工具");
migrateCmd
  .command("new <slug>")
  .description("生成下一个编号的迁移骨架文件（自动取号，避免单分支手挑撞号）")
  .action((slug: string) => {
    try {
      const { file, version, path } = scaffoldMigration(slug);
      console.log(`已创建迁移 v${version}：${file}`);
      console.log(`  ${path}`);
      console.log(`填好 up(db) 后跑 \`autopilot upgrade\` 应用。`);
    } catch (e: unknown) {
      console.error((e as Error)?.message ?? String(e));
      process.exit(1);
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
