import { mkdirSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME, VERSION } from "../index";
import { initDb, closeDb } from "../core/db";
import { runPendingMigrations } from "../core/migrate";
import { discover } from "../core/registry";
import { checkStuckTasks } from "../core/watcher";
import { initDaemonFileLog } from "../core/logger";
import { enableBus, disableBus, bus } from "./event-bus";
import { wsManager } from "./ws";
import { startServer } from "./server";
import { setWebDistDir } from "./routes";
import { writePid, removePid, isDaemonRunning } from "./pid";
import type { AutopilotEvent } from "./protocol";

// ──────────────────────────────────────────────
// Daemon 入口
// ──────────────────────────────────────────────

const DEFAULT_PORT = 6180;
const DEFAULT_HOST = "127.0.0.1";
const WATCHER_INTERVAL_MS = 60_000;

export interface DaemonOptions {
  host?: string;
  port?: number;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<void> {
  const host = opts.host ?? process.env.AUTOPILOT_HOST ?? DEFAULT_HOST;
  const port = opts.port ?? (process.env.AUTOPILOT_PORT ? parseInt(process.env.AUTOPILOT_PORT, 10) : DEFAULT_PORT);

  // 检查是否已有 daemon 运行
  if (isDaemonRunning()) {
    console.error("错误：daemon 已在运行中。");
    process.exit(1);
  }

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

  // 桥接：事件总线 → WebSocket 广播
  bus.on("*", (event: AutopilotEvent) => {
    wsManager.broadcast(event);
  });

  // 配置静态文件目录
  const webDistDir = join(import.meta.dir, "../../web-dist");
  setWebDistDir(webDistDir);

  // 启动 HTTP + WebSocket 服务
  const server = startServer({ host, port });

  // 写入 PID 文件
  writePid();

  // 启动 watcher 定时器
  const watcherTimer = setInterval(() => {
    try {
      checkStuckTasks();
    } catch (e: unknown) {
      console.error("watcher 异常：", e instanceof Error ? e.message : String(e));
    }
  }, WATCHER_INTERVAL_MS);

  console.log(`autopilot daemon v${VERSION} started on http://${host}:${port} (pid=${process.pid})`);

  // 优雅退出
  const shutdown = () => {
    console.log("\ndaemon 正在关闭...");
    clearInterval(watcherTimer);
    disableBus();
    server.stop();
    closeDb();
    removePid();
    console.log("daemon 已关闭。");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 如果直接运行此文件，启动 daemon
if (import.meta.main) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf("--port");
  const hostIdx = args.indexOf("--host");

  const opts: DaemonOptions = {};
  if (portIdx !== -1 && args[portIdx + 1]) opts.port = parseInt(args[portIdx + 1], 10);
  if (hostIdx !== -1 && args[hostIdx + 1]) opts.host = args[hostIdx + 1];

  startDaemon(opts);
}
