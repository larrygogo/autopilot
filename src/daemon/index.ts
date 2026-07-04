import { mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { AUTOPILOT_HOME, VERSION } from "../index";
import { installAutopilotResolver } from "../core/autopilot-resolver";
import { initDb, closeDb, listTasks, updateTask, closeOpenPhaseEvents } from "../core/db";
import { forceTransition } from "../core/state-machine";
import { runPendingMigrations } from "../core/migrate";
import { discover } from "../core/workflow/registry";
import { listOutdatedWorkflowCopies } from "../core/workflow/templates";
import { checkStuckTasks, pruneSandboxesByPolicy } from "../core/watcher";
import { runInBackground } from "../core/runner";
import { initDaemonFileLog, log } from "../core/logger";
import { loadDaemonConfig, loadGithubConfig, getConfigPath, ensureJsonConfig } from "../core/config";
import { enableBus, disableBus, bus, emit as emitEvent } from "../core/event-bus";
import { pollAllPRs } from "./pr-poller";
import { wsManager } from "./ws";
import { startServerWithRetry } from "./server";
import { setWebDistDir, reloadApiToken, getApiTokenState, extendAllowedOrigins, detectLanIPv4, isExposedHost, startupAuthBlocked } from "./routes";
import { generateApiToken, saveApiToken } from "../core/api-token";
import { hasAnyUser } from "../core/auth";
import { writePid, removePid, isDaemonRunning, writeListenInfo, removeListenInfo, writeRestartFlag, consumeRestartFlag, isSupervisorRunning } from "./pid";
import { initRequirementScheduler, disposeRequirementScheduler } from "./requirement-scheduler";
import { initRequirementClarifier, disposeRequirementClarifier } from "./requirement-clarifier";
import { initProviderCliMonitor, disposeProviderCliMonitor } from "./provider-cli-monitor";
import { initUpdateMonitor, disposeUpdateMonitor } from "../core/update-check";
import { runClarifierWatchdog } from "./clarifier-watchdog";
import { initRequirementTaskBridge, disposeRequirementTaskBridge } from "./requirement-task-bridge";
import { initFixRevisionRunner, disposeFixRevisionRunner } from "./fix-revision-runner";
import { initDoneWorkspaceCleanup, disposeDoneWorkspaceCleanup } from "./done-workspace-cleanup";
import { initMcpRuntime, disposeMcpRuntime } from "./mcp-runtime";
import { listUsableProviders, ensureDefaultProviderSet, resolveDefaultProvider } from "../core/default-provider";
import type { AutopilotEvent } from "./protocol";
import { RESTART_SENTINEL_CODE, FATAL_CONFIG_CODE } from "./supervisor";
import { writeFileSync, existsSync, unlinkSync, watch as fsWatch } from "fs";

// ──────────────────────────────────────────────
// Module 级 shutdown 注册表
// supervisor 模式下 daemon 内 RPC（如 daemon.restart）需要主动触发自身退出，
// 走相同的 shutdown 清理路径但 exit code 不同。
// ──────────────────────────────────────────────
let _activeShutdown: ((exitCode: number) => void) | null = null;

/**
 * 由 RPC 等内部调用方触发 daemon 重启。
 *
 * 行为：先写 restart.flag 标志，然后下一 tick 调 shutdown(75)，supervisor
 * 看到 sentinel code 立即 respawn。新 daemon 启动时 recoverDanglingTasks 会
 * 检测到 flag 文件存在 → 知道这次是主动 respawn → 走 await_review 同款的
 * 自动重启路径而不是把 task 标 dangling 等用户介入。
 *
 * delayMs 默认 100ms 给客户端 RPC 响应留出回流窗口。
 *
 * 裸跑 daemon（无 supervisor）：没人 respawn，重启 = 自杀且不回来。此时**拒绝重启、不退出**，
 * 返回 false 让客户端明确提示「请手动 stop+start」——而不是静默把 daemon 杀掉、让 Web
 * 轮询 15s 后 reload 到一个已死的 daemon（旧实现 _activeShutdown 无条件赋值，bare 模式也返 true 的假信号）。
 */
export function requestRestart(delayMs = 100): boolean {
  if (!_activeShutdown) return false;
  if (!isSupervisorRunning()) return false;
  writeRestartFlag();
  const fn = _activeShutdown;
  setTimeout(() => fn(RESTART_SENTINEL_CODE), delayMs);
  return true;
}

/**
 * 由 RPC 触发 daemon 优雅退出（exit 0 → supervisor classifyExit=exit_clean 一并退出）。
 * 与 SIGTERM 路径的关键区别：Windows 下 SIGTERM 是 TerminateProcess（硬杀，cleanup
 * handler 跑不到），进程死时若有活跃 WS/HTTP 连接，内核可能留下无主的 zombie LISTEN
 * socket（CLOSE_WAIT 无超时，永不自愈，端口直到重启机器都不可用——2026-06-10 事故）。
 * 走本路径 daemon 自己 server.stop() 正常关闭全部 socket，不会产生 zombie。
 */
export function requestShutdown(delayMs = 150): boolean {
  if (!_activeShutdown) return false;
  const fn = _activeShutdown;
  setTimeout(() => fn(0), delayMs);
  return true;
}

// restart.flag 的写入/消费 helpers 收口在 pid.ts（CLI `daemon restart` 也要写 flag）

// ──────────────────────────────────────────────
// Daemon 入口
// ──────────────────────────────────────────────

const DEFAULT_PORT = 6180;
const DEFAULT_HOST = "127.0.0.1";
const WATCHER_INTERVAL_MS = 60_000;
const CLARIFIER_WATCHDOG_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 3600_000;  // 每小时扫一次 workspace 保留策略
// PR_POLL_INTERVAL_MS 由 config.json.github.poll_interval_seconds 决定

export interface DaemonOptions {
  host?: string;
  port?: number;
  /** 显式允许"暴露 0.0.0.0 但不设 token"的裸奔配置。默认不允许。 */
  insecureNoAuth?: boolean;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<void> {
  // 自动迁移 config.yaml → config.json（一次性、幂等）
  ensureJsonConfig();

  // 优先级：显式参数 > env > config.json > 内置默认
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

  // API token 加载（鉴权用）。SEC-6 启动安全门移到 initDb/migrations 后以便查 hasAnyUser，见下。
  reloadApiToken();

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

  // 安全门（SEC-6）：暴露 host 必须已设防（API token 或登录用户），否则内网裸奔。
  // 移到 initDb/migrations 后以便查 hasAnyUser——A2 后 JWT 是服务端一等鉴权，有用户=已设防。
  //
  // 2026-06-11 起从「拒启 exit(2)」改为「自动设防」：无防护时自动生成 token 写入
  // runtime/api-token 并继续启动 —— 生成后系统即是设防状态（远端必须提供 token，
  // TokenGate 会拦），安全语义不降级，而「配置矛盾 → 重启才引爆 → 启不起来」的
  // 反复事故（2026-06-10/11 两次）从根上消除。仅 token 写盘失败时才退回拒启。
  {
    const tokenState = getApiTokenState();
    if (startupAuthBlocked(host, tokenState.is_set, hasAnyUser(), !!opts.insecureNoAuth)) {
      try {
        const token = generateApiToken();
        saveApiToken(token);
        reloadApiToken();
        log.warn(
          "SEC-6 安全门：host=%s 对外暴露但未设防 → 已自动生成 API token 并继续启动。" +
          "远端访问需提供 token（本机 Web 设置页 → 网络访问 可查看/轮换；文件在 runtime/api-token）",
          host,
        );
      } catch (e: unknown) {
        // 自动设防失败（如磁盘只读）→ 维持拒启语义
        // supervisor 模式下子进程 stderr 被 ignore，console.error 用户看不到；
        // 必须同时写 daemon.log，否则表象只是"无法启动"（2026-06-10 事故）
        log.error(
          "SEC-6 启动安全门拦截：host=%s 对外暴露未设防，且自动生成 token 失败（%s），daemon 退出 (code=2)。" +
          "解法：Web 设置页生成 token / 写 runtime/api-token 文件 / 设 AUTOPILOT_API_TOKEN / 切回 127.0.0.1 / --insecure-no-auth",
          host, e instanceof Error ? e.message : String(e),
        );
        console.error(`
错误：daemon 配置为监听 ${host}（对外暴露）且未设防，自动生成 API token 失败。

请选择以下之一：
  1. 在 Web 设置页生成 token 或创建登录用户（推荐）
  2. 写入 ~/.autopilot/runtime/api-token 文件（一行 token 文本）
  3. 设置环境变量 AUTOPILOT_API_TOKEN
  4. 切回 127.0.0.1（autopilot daemon stop && autopilot daemon run，或改 config.json）
  5. 明知风险仍要继续：autopilot daemon run --insecure-no-auth
`);
        process.exit(FATAL_CONFIG_CODE);
      }
    }
  }

  // 发现工作流
  await discover();

  // ── provider 就绪门（P1）：不拒启（provider 缺失是能在线修复的状态，吸取 SEC-6 教训），
  //    只 warn + 自动把「第一个可用 provider」设为系统默认（providers.default 未显式设时）。
  try {
    const usable = await listUsableProviders();
    if (usable.length === 0) {
      log.warn(
        "尚无可用的 AI 供应商（CLI 未登录 / API key 未配）——执行类操作（澄清 / 入队 / 起任务）会被拒绝。" +
        "在「设置 → 提供商」配置后即可恢复，无需重启。",
      );
    } else {
      await ensureDefaultProviderSet(); // 仅「恰好一个可用」时自动 pin；多个交给派生
      log.info("默认 AI 供应商：%s（可用 %d 个）", resolveDefaultProvider(), usable.length);
    }
  } catch (e: unknown) {
    log.warn("provider 就绪门检查异常（忽略，不阻塞启动）：%s", e instanceof Error ? e.message : String(e));
  }

  // 激活事件总线
  enableBus();

  // ── 外部编辑 config.json 热生效 ──────────────────────────────────────────
  // 监听目录（而非文件）有两个好处：
  //   1. daemon 启动时 config.json 不存在也能正常监听，文件创建后即可热生效
  //   2. 部分编辑器（如 vim、Emacs）先写临时文件再重命名，监听文件会失去跟踪
  // 防抖 300ms：编辑器保存时 fs.watch 可能连续触发（Windows 尤甚）。
  // 已通过 RPC/Web UI 写的路径（rpc-methods.ts / routes.ts）不受此影响，各自 emit。
  const configFilePath = getConfigPath();
  const configDir = dirname(configFilePath);
  const configFilename = basename(configFilePath);
  let configWatchDebounce: ReturnType<typeof setTimeout> | null = null;
  let configDirWatcher: ReturnType<typeof fsWatch> | null = null;
  try {
    configDirWatcher = fsWatch(configDir, { persistent: false }, (_event, filename) => {
      // filename 为 null/undefined 时（某些平台不提供）也触发；
      // 归一化为 string 再比较（部分环境可能传 Buffer）
      if (filename != null && String(filename) !== configFilename) return;
      if (configWatchDebounce) clearTimeout(configWatchDebounce);
      configWatchDebounce = setTimeout(() => {
        configWatchDebounce = null;
        log.info("config.json 检测到外部变化（目录监听），发射 config:updated 热生效");
        emitEvent({ type: "config:updated", payload: {} });
      }, 300);
    });
    log.info("config 目录监听已启动：%s（目标文件：%s）", configDir, configFilename);
  } catch (e: unknown) {
    // 目录不存在或权限不足时跳过（daemon 仍正常运行，热生效不可用）
    log.warn("config 目录监听启动失败，外部编辑热生效不可用：%s", (e as Error).message);
  }
  // ──────────────────────────────────────────────────────────────────────────

  // dogfood-bug27/28：config 或 workflow 改了之后 agent cache 必须丢弃，
  // 否则下个 task 还用老配置（cache key 是 workflowName:agentName，旧 Provider
  // 实例还持着旧 model / system_prompt / MCP 连接）。
  const { onEvent } = await import("../core/event-bus");
  const { clearAllAgentCache } = await import("../agents/registry");
  const refreshAgentCache = (reason: string) => {
    clearAllAgentCache().catch((e: unknown) => {
      console.error(`${reason} 后清 agent cache 失败：`, e instanceof Error ? e.message : String(e));
    });
  };
  onEvent("config:updated", () => refreshAgentCache("config:updated"));
  onEvent("workflow:reloaded", () => refreshAgentCache("workflow:reloaded"));

  // 注册 RPC method（WS req/res 协议用，对 HTTP routes 无影响）
  const { registerCoreRpcMethods } = await import("./rpc-methods");
  registerCoreRpcMethods();

  // 启动通知 recorder（事件型通知流；必须先于 scheduler / 恢复逻辑挂订阅，避免漏记）
  const { initNotificationRecorder } = await import("./notification-recorder");
  const disposeNotificationRecorder = initNotificationRecorder();

  // 启动 selfhosted-connector（B-interactive 模式：assignments/commands 轮询 + 全状态镜像推送）
  // 通过扩展点 API 装配：reqgenieExtension.enabled() 内部检查 config + 凭证，未启用则跳过
  const { registerExtension, initExtensions } = await import("./extensions/registry");
  const { reqgenieExtension } = await import("./selfhosted-connector/extension");
  registerExtension(reqgenieExtension);
  const disposeSelfhostedConnector = initExtensions();

  // 启动 requirement-scheduler（订阅 event-bus）
  initRequirementScheduler();
  // 启动 requirement-clarifier（创建需求后自动 AI 澄清）
  initRequirementClarifier();
  // 启动 provider CLI 主动探测（5 分钟周期）
  initProviderCliMonitor();
  // 更新检查：本地是否落后远端（启动跑一次，之后每 6h；只读 git ls-remote）
  initUpdateMonitor();
  // 桥接 task 状态变化 → 同步 requirement 状态
  initRequirementTaskBridge();
  // fix_revision 修复执行器（v2 R3：注册内置 __fix 工作流 + fix_revision → 创建 kind=fix
  // 标准 run）。必须先于 recoverDanglingTasks——恢复 running_fix 任务要能找到 __fix 工作流。
  initFixRevisionRunner();
  // 需求完成即清任务 workspace（交付已在远程 PR，本地 clone 占空间无保留价值）
  initDoneWorkspaceCleanup();
  // 工作流副本落后检查：仅当本地副本 template_revision 落后内置模板才提示一次（替掉 factory 的无条件 warn）
  try {
    const outdated = listOutdatedWorkflowCopies();
    if (outdated.length > 0) {
      log.warn(
        "以下工作流副本落后于内置模板，建议同步（autopilot workflow sync <name> --apply）：%s",
        outdated.map((o) => `${o.name}（本地 r${o.local} < 模板 r${o.template}）`).join("、"),
      );
    }
  } catch { /* best-effort，不阻塞启动 */ }

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

  // 重启检测：区分主动 respawn vs 崩溃，决定怎么处理 running_* task。
  // - 主动重启（daemon.restart RPC 触发 exit 75）：consumeRestartFlag 返回 true →
  //   认为 task 只是被用户主动打断，自动 respawn 让它们继续跑
  // - 崩溃 / 干净启动：保守标 dangling 让用户决定 cancel/retry
  const isRespawnContinuation = consumeRestartFlag();
  recoverDanglingTasks(isRespawnContinuation);

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

  // sandbox 保留策略定时器（配置为空时函数内部会提前返回）
  // dogfood-bug25：启动时**立即跑一次**，否则 setInterval 1 小时后才第一次触发，
  // 上次 daemon 停机期间累积的旧 sandbox 在新启动后第一小时完全不会清。
  const runRetention = () => {
    try {
      pruneSandboxesByPolicy();
    } catch (e: unknown) {
      console.error("retention 异常：", e instanceof Error ? e.message : String(e));
    }
  };
  runRetention();
  const retentionTimer = setInterval(runRetention, RETENTION_INTERVAL_MS);

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
    clearInterval(prPollerTimer);
    configDirWatcher?.close();
    if (configWatchDebounce) {
      clearTimeout(configWatchDebounce);
      configWatchDebounce = null;
    }
    disposeRequirementScheduler();
    disposeRequirementClarifier();
    disposeProviderCliMonitor();
    disposeUpdateMonitor();
    disposeRequirementTaskBridge();
    disposeFixRevisionRunner();
    disposeDoneWorkspaceCleanup();
    disposeNotificationRecorder();
    disposeSelfhostedConnector();
    disableBus();
    // server.stop 必须 await 完成后才能 exit：它是异步的（等 socket 真正关闭），
    // 同步调用后立刻 process.exit 会让进程死在 socket 关闭中途——浏览器保持着
    // WS/HTTP 连接时，Windows 内核会留下归属死 pid 的 zombie LISTEN（端口直到
    // 重启机器都 EADDRINUSE）。stop(true) 强制断开所有活动连接，不等客户端配合。
    void (async () => {
      try { await server.stop(true); } catch { /* 已停 */ }
      closeDb();
      disposeMcpRuntime();
      removePid();
      removeListenInfo();
      console.log("daemon 已关闭。");
      process.exit(exitCode);
    })();
    // 兜底：若 stop 卡死（极端），3s 后强制退出——此时连接已被 stop(true) 尽力断开
    setTimeout(() => process.exit(exitCode), 3000).unref?.();
  };

  _activeShutdown = shutdown;

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

export function recoverDanglingTasks(
  isRespawnContinuation = false,
  deps: { runInBackground?: (taskId: string, phase: string) => void } = {},
): void {
  const runFn = deps.runInBackground ?? runInBackground;
  try {
    const tasks = listTasks({});
    let danglingCount = 0;
    let respawnCount = 0;
    // daemon 重启时，所有 running_* 任务的内存 phase promise 都已丢失。
    // 处理策略分两类：
    //  1. await_review 是设计上的长挂起 polling 阶段，幂等可重启 →
    //     直接 runInBackground 重新 spawn，无需用户介入
    //  2. 其他 running_<phase>：
    //     - isRespawnContinuation=true（主动 daemon.restart 触发的 respawn）→
    //       同样 runInBackground，让 phase 继续跑（用户明确触发的重启，不应
    //       打断业务）
    //     - 否则（崩溃 / 干净启动）→ 标 dangling 让 UI 提示用户决定
    for (const t of tasks) {
      const isWaiting = t.status.startsWith("waiting_");
      if (!t.status.startsWith("running_") && !isWaiting) continue;
      const phase = isWaiting ? t.status.slice("waiting_".length) : t.status.slice("running_".length);

      // 并行块 waiting_<group>（CONC-01）：子阶段内存 promise 在重启时已丢，回退 pending_<group>
      // 重跑整组（并行块可幂等重跑；executeParallelGroup 的 fork 要求当前是 pending_<group>）。
      // 无 dangling 中间态——直接自动恢复。
      if (isWaiting) {
        log.info(
          "task %s 在 daemon 启动时停留在 %s（并行块挂起）→ 回退 pending_%s 重跑整组",
          t.id, t.status, phase,
        );
        if (t["dangling"]) updateTask(t.id, { dangling: false });
        // 旧 daemon 死时来不及收尾的 open phase event 先关掉，否则重跑会再开一条，
        // 执行时间线出现两个并行转圈的同名轮次
        closeOpenPhaseEvents(t.id);
        try {
          forceTransition(t.id, `pending_${phase}`, "daemon 启动：并行块中断，回退重跑整组");
        } catch (e: unknown) {
          log.error("recoverDanglingTasks: 回退 waiting_%s 失败 task=%s: %s", phase, t.id, (e as Error).message);
          continue;
        }
        runFn(t.id, phase);
        respawnCount++;
        continue;
      }

      if (t.status === "running_await_review") {
        log.info(
          "task %s 在 daemon 启动时停留在 running_await_review → 自动重启 await_review",
          t.id,
        );
        if (t["dangling"]) updateTask(t.id, { dangling: false });
        closeOpenPhaseEvents(t.id);
        runFn(t.id, "await_review");
        respawnCount++;
        continue;
      }

      if (isRespawnContinuation) {
        // 主动重启：跟 await_review 同款的自动 respawn 路径
        log.info(
          "task %s 在 daemon 主动重启时仍处于 %s → 自动重启 phase %s",
          t.id, t.status, phase,
        );
        if (t["dangling"]) updateTask(t.id, { dangling: false });
        closeOpenPhaseEvents(t.id);
        runFn(t.id, phase);
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
    if (isRespawnContinuation) {
      log.info("此次启动是主动 respawn 的延续，%d 个 task 已自动重启 phase 函数", respawnCount);
    } else {
      if (danglingCount > 0) {
        log.warn("共 %d 个 task 因 daemon 重启被标 dangling，请在 UI 选择取消或重启", danglingCount);
      }
      if (respawnCount > 0) {
        log.info("共 %d 个 await_review task 在 daemon 启动时被自动 respawn", respawnCount);
      }
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
