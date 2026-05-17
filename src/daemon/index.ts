import { mkdirSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME, VERSION } from "../index";
import { installAutopilotResolver } from "../core/autopilot-resolver";
import { initDb, closeDb, listTasks, updateTask } from "../core/db";
import { runPendingMigrations } from "../core/migrate";
import { discover } from "../core/registry";
import { checkStuckTasks, pruneWorkspacesByPolicy } from "../core/watcher";
import { runInBackground } from "../core/runner";
import { runScheduledTasks } from "../core/scheduler";
import { initDaemonFileLog, log } from "../core/logger";
import { loadDaemonConfig, loadGithubConfig } from "../core/config";
import { enableBus, disableBus, bus } from "../core/event-bus";
import { pollAllPRs } from "./pr-poller";
import { wsManager } from "./ws";
import { startServerWithRetry } from "./server";
import { setWebDistDir, reloadApiToken, getApiTokenState, extendAllowedOrigins, detectLanIPv4, isExposedHost } from "./routes";
import { writePid, removePid, isDaemonRunning, writeListenInfo, removeListenInfo } from "./pid";
import { initRequirementScheduler, disposeRequirementScheduler } from "./requirement-scheduler";
import { initRequirementClarifier, disposeRequirementClarifier } from "./requirement-clarifier";
import { initProviderCliMonitor, disposeProviderCliMonitor } from "./provider-cli-monitor";
import { runClarifierWatchdog } from "./clarifier-watchdog";
import { initRequirementTaskBridge, disposeRequirementTaskBridge } from "./requirement-task-bridge";
import { initMcpRuntime, disposeMcpRuntime } from "./mcp-runtime";
import { createDefaultAggregator, type Aggregator } from "../core/now-aggregator";
import { setNowAggregator } from "./routes-now";
import type { AutopilotEvent } from "./protocol";
import { RESTART_SENTINEL_CODE } from "./supervisor";

// ──────────────────────────────────────────────
// Module 级 shutdown 注册表
// supervisor 模式下 daemon 内 RPC（如 daemon.restart）需要主动触发自身退出，
// 走相同的 shutdown 清理路径但 exit code 不同。
// ──────────────────────────────────────────────
let _activeShutdown: ((exitCode: number) => void) | null = null;

/**
 * 由 RPC 等内部调用方触发 daemon 重启。
 *
 * 行为：在下一 tick 调用 shutdown(75)，supervisor 看到 sentinel code 立即 respawn。
 * delayMs 默认 100ms 给客户端 RPC 响应留出回流窗口。
 *
 * 注：必须在 supervisor 模式下使用；裸跑 daemon（无 supervisor）调用此函数等同于 stop。
 */
export function requestRestart(delayMs = 100): boolean {
  if (!_activeShutdown) return false;
  const fn = _activeShutdown;
  setTimeout(() => fn(RESTART_SENTINEL_CODE), delayMs);
  return true;
}

// ──────────────────────────────────────────────
// Daemon 入口
// ──────────────────────────────────────────────

const DEFAULT_PORT = 6180;
const DEFAULT_HOST = "127.0.0.1";
const WATCHER_INTERVAL_MS = 60_000;
const CLARIFIER_WATCHDOG_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 3600_000;  // 每小时扫一次 workspace 保留策略
const SCHEDULER_INTERVAL_MS = 30_000;    // 每 30 秒扫一次定时任务（精度到分钟）
// PR_POLL_INTERVAL_MS 由 config.yaml.github.poll_interval_seconds 决定

export interface DaemonOptions {
  host?: string;
  port?: number;
  /** 显式允许"暴露 0.0.0.0 但不设 token"的裸奔配置。默认不允许。 */
  insecureNoAuth?: boolean;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<void> {
  // 优先级：显式参数 > env > config.yaml > 内置默认
  const cfg = loadDaemonConfig();
  const host = opts.host
    ?? process.env.AUTOPILOT_HOST
    ?? cfg.host
    ?? DEFAULT_HOST;
  const port = opts.port
    ?? (process.env.AUTOPILOT_PORT ? parseInt(process.env.AUTOPILOT_PORT, 10) : undefined)
    ?? cfg.port
    ?? DEFAULT_PORT;

  // 检查是否已有 daemon 运行
  if (isDaemonRunning()) {
    console.error("错误：daemon 已在运行中。");
    process.exit(1);
  }

  // 安全检查：暴露 host 必须设 token，否则等于内网裸奔
  reloadApiToken();
  const tokenState = getApiTokenState();
  if (isExposedHost(host) && !tokenState.is_set && !opts.insecureNoAuth) {
    console.error(`
错误：daemon 配置为监听 ${host}（对外暴露），但未设置 API token。

这意味着同网段的任何人都能访问你的任务、凭证、Agent 调用，等于内网裸奔。

请选择以下之一：
  1. 在 Web 设置页生成 token（推荐）
  2. 写入 ~/.autopilot/runtime/api-token 文件（一行 token 文本）
  3. 设置环境变量 AUTOPILOT_API_TOKEN
  4. 切回 127.0.0.1（autopilot daemon stop && autopilot daemon run，或改 config.yaml）
  5. 明知风险仍要继续：autopilot daemon run --insecure-no-auth
`);
    process.exit(2);
  }

  // 暴露 host 时把所有 LAN IP 加进 CORS allowlist —— 从同网段其他机器浏览器访问
  // daemon serve 的 SPA 时（同源访问 daemon 自己），同源策略下不会触发 CORS；
  // 但若用户用别的本地工具跨域调 daemon，allowlist 能让它通过。
  if (isExposedHost(host)) {
    const origins = detectLanIPv4().map((ip) => `http://${ip}:${port}`);
    extendAllowedOrigins(origins);
  }

  // 安装 @autopilot/* 别名解析器（必须早于任何 dynamic import 用户工作流）
  installAutopilotResolver();

  // 确保运行时目录存在
  mkdirSync(join(AUTOPILOT_HOME, "runtime"), { recursive: true });

  // 激活 daemon 主日志文件（所有 logger 输出同时写到此文件；带简单 size 轮转）
  initDaemonFileLog(join(AUTOPILOT_HOME, "runtime", "logs", "daemon.log"));

  // 初始化数据库 + 迁移
  initDb();
  await runPendingMigrations();

  // 发现工作流
  await discover();

  // 激活事件总线
  enableBus();

  // 注册 RPC method（WS req/res 协议用，对 HTTP routes 无影响）
  const { registerCoreRpcMethods } = await import("./rpc-methods");
  registerCoreRpcMethods();

  // 启动 /now 状态推导引擎
  const nowAggregator: Aggregator = createDefaultAggregator();
  await nowAggregator.start();
  setNowAggregator(nowAggregator);
  log.info("now-aggregator 已启动，当前卡片数 %d", nowAggregator.getCards().length);

  // 启动 requirement-scheduler（订阅 event-bus）
  initRequirementScheduler();
  // 启动 requirement-clarifier（创建需求后自动 AI 澄清）
  initRequirementClarifier();
  // 启动 provider CLI 主动探测（5 分钟周期）
  initProviderCliMonitor();
  // 桥接 task 状态变化 → 同步 requirement 状态
  initRequirementTaskBridge();

  // 桥接：事件总线 → WebSocket 广播
  bus.on("*", (event: AutopilotEvent) => {
    wsManager.broadcast(event);
  });

  // 配置静态文件目录
  const webDistDir = join(import.meta.dir, "../../web-dist");
  setWebDistDir(webDistDir);

  // 生成 MCP token + 写 mcp-config.json（必须在 startServer 之前调用：
  // /mcp 路由用 getMcpToken() 判鉴权；如果 server 先起来、initMcpRuntime 后跑，
  // 中间窗口 token=null → mcp-server 把空 token 当成不鉴权 → 任何本地进程
  // 可无认证调全部 autopilot 工具，构成本地权限提升）。
  initMcpRuntime(host, port);

  // 启动 HTTP + WebSocket 服务（端口被 stale socket 占用时自动重试）
  const server = await startServerWithRetry({ host, port });

  // 写入 PID 和监听信息
  writePid();
  writeListenInfo({ host, port });

  // 重启检测：把所有 status=running_* 且 pending_question 非空的 task 标 dangling
  // —— ask_user 的 in-memory promise 在 daemon 重启时丢失，agent 永远收不到 tool result，
  // 这些 task 实际已死，UI 看到 dangling=true 时会提示用户取消重启。
  recoverDanglingTasks();

  // 启动 watcher 定时器
  const watcherTimer = setInterval(() => {
    try {
      checkStuckTasks();
    } catch (e: unknown) {
      console.error("watcher 异常：", e instanceof Error ? e.message : String(e));
    }
  }, WATCHER_INTERVAL_MS);

  const clarifierWatchdogTimer = setInterval(() => {
    runClarifierWatchdog().catch((e: unknown) => {
      console.error("clarifier-watchdog 异常：", e instanceof Error ? e.message : String(e));
    });
  }, CLARIFIER_WATCHDOG_INTERVAL_MS);

  // workspace 保留策略定时器（配置为空时函数内部会提前返回）
  const retentionTimer = setInterval(() => {
    try {
      pruneWorkspacesByPolicy();
    } catch (e: unknown) {
      console.error("retention 异常：", e instanceof Error ? e.message : String(e));
    }
  }, RETENTION_INTERVAL_MS);

  // scheduler 定时器：扫描到期的 schedule，创建对应任务
  const schedulerTimer = setInterval(() => {
    runScheduledTasks().catch((e: unknown) => {
      console.error("scheduler 异常：", e instanceof Error ? e.message : String(e));
    });
  }, SCHEDULER_INTERVAL_MS);

  // pr-poller 定时器：扫 awaiting_review 需求的 PR，自动注入 review 反馈 / 标 done
  const ghCfg = loadGithubConfig();
  const prPollerInterval = ghCfg.poll_interval_seconds * 1000;
  const prPollerTimer = setInterval(() => {
    pollAllPRs().catch((e: unknown) => {
      console.error("pr-poller 异常：", e instanceof Error ? e.message : String(e));
    });
  }, prPollerInterval);
  log.info("pr-poller 已启动，轮询间隔 %ss", ghCfg.poll_interval_seconds);

  console.log(`autopilot daemon v${VERSION} started on http://${host}:${port} (pid=${process.pid})`);

  // 优雅退出
  const shutdown = (exitCode = 0) => {
    console.log(`\ndaemon 正在关闭${exitCode === RESTART_SENTINEL_CODE ? "（请求 respawn）" : ""}...`);
    clearInterval(watcherTimer);
    clearInterval(clarifierWatchdogTimer);
    clearInterval(retentionTimer);
    clearInterval(schedulerTimer);
    clearInterval(prPollerTimer);
    disposeRequirementScheduler();
    disposeRequirementClarifier();
    disposeProviderCliMonitor();
    disposeRequirementTaskBridge();
    nowAggregator.dispose();
    setNowAggregator(null);
    disableBus();
    server.stop();
    closeDb();
    disposeMcpRuntime();
    removePid();
    removeListenInfo();
    console.log("daemon 已关闭。");
    process.exit(exitCode);
  };

  _activeShutdown = shutdown;

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

function recoverDanglingTasks(): void {
  try {
    const tasks = listTasks({});
    let danglingCount = 0;
    let respawnCount = 0;
    // daemon 重启时，所有 running_* 任务的内存 phase promise 都已丢失。
    // 处理策略分两类：
    //  1. await_review 是设计上的长挂起 polling 阶段，幂等可重启 →
    //     直接 runInBackground 重新 spawn，无需用户介入
    //  2. 其他 running_<phase>（含 agent 调用、I/O 等不可幂等的操作）→
    //     标 dangling，让 UI 提示用户决定取消还是 restart
    for (const t of tasks) {
      if (!t.status.startsWith("running_")) continue;

      if (t.status === "running_await_review") {
        // 幂等阶段，daemon 启动后立即 respawn 即可恢复
        log.info(
          "task %s 在 daemon 重启时停留在 running_await_review → 自动重启该阶段函数",
          t.id,
        );
        // 清掉历史可能残留的 dangling 标记
        if (t["dangling"]) updateTask(t.id, { dangling: false });
        runInBackground(t.id, "await_review");
        respawnCount++;
        continue;
      }

      if (t["dangling"]) continue;
      updateTask(t.id, { dangling: true });
      log.warn(
        "task %s 在 daemon 重启时仍处于 %s → 标记 dangling（phase 执行已丢失，UI 会提示用户）",
        t.id, t.status,
      );
      danglingCount++;
    }
    if (danglingCount > 0) {
      log.warn("共 %d 个 task 因 daemon 重启被标 dangling，请在 UI 选择取消或重启", danglingCount);
    }
    if (respawnCount > 0) {
      log.info("共 %d 个 await_review task 在 daemon 启动时被自动 respawn", respawnCount);
    }
  } catch (e: unknown) {
    console.error("recoverDanglingTasks 异常：", e instanceof Error ? e.message : String(e));
  }
}

// 如果直接运行此文件，启动 daemon
if (import.meta.main) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf("--port");
  const hostIdx = args.indexOf("--host");

  const opts: DaemonOptions = {};
  if (portIdx !== -1 && args[portIdx + 1]) opts.port = parseInt(args[portIdx + 1], 10);
  if (hostIdx !== -1 && args[hostIdx + 1]) opts.host = args[hostIdx + 1];
  if (args.includes("--insecure-no-auth")) opts.insecureNoAuth = true;

  startDaemon(opts);
}
