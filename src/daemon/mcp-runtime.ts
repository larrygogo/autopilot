// ──────────────────────────────────────────────
// MCP 运行时：daemon 生命周期内的 token 生成 + mcp-config.json 写入
//
// daemon 启动时生成一次性 token，写到 ~/.autopilot/runtime/mcp-config.json，
// AnthropicProvider 通过 `--mcp-config <path> --strict-mcp-config` 把它喂给
// 本地 claude CLI；claude 用 token 调 daemon 的 /mcp HTTP 路由。
//
// 注意：token 仅在 daemon 进程内存里活着，文件落到磁盘的是 mcp-config.json
// （含 token）。daemon 退出时清理 config 文件，避免残留凭据。
// ──────────────────────────────────────────────

import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { AUTOPILOT_HOME } from "../index";
import { clearPerTaskMcpConfigs } from "../agents/mcp-task-config";

let currentToken: string | null = null;
let currentConfigPath: string | null = null;
let currentServerUrl: string | null = null;

export function getMcpToken(): string | null {
  return currentToken;
}

/** 当前 mcp-config.json 的绝对路径；未初始化时返回 null。 */
export function getMcpConfigPath(): string | null {
  return currentConfigPath;
}

/** Server 暴露的 HTTP URL（含 path）；用于诊断和给 claude 配置使用。 */
export function getMcpServerUrl(): string | null {
  return currentServerUrl;
}

/**
 * daemon 启动时调用：生成 token、写 mcp-config.json。
 *
 * @param host daemon 监听 host（127.0.0.1 时 URL 就用它；0.0.0.0 时退回 127.0.0.1）
 * @param port daemon 监听 port
 */
export function initMcpRuntime(host: string, port: number): void {
  currentToken = randomBytes(32).toString("hex");
  // 0.0.0.0 监听时给 claude 的 URL 还是连 127.0.0.1（本机使用）
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  currentServerUrl = `http://${urlHost}:${port}/mcp`;

  // 清掉上次运行残留的 per-task 配置（含旧 token），避免陈旧凭据/标识。
  clearPerTaskMcpConfigs();

  const configPath = join(AUTOPILOT_HOME, "runtime", "mcp-config.json");
  mkdirSync(dirname(configPath), { recursive: true });

  const config = {
    mcpServers: {
      autopilot: {
        type: "http",
        url: currentServerUrl,
        headers: {
          Authorization: `Bearer ${currentToken}`,
        },
      },
    },
  };
  // mode 0o600：文件含 bearer token，仅 owner 可读写。Windows 上 NTFS 不强制
  // unix mode（noop），macOS/Linux 上能有效降低本机其他用户读到 token 的风险。
  writeFileSync(configPath, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  currentConfigPath = configPath;
}

/** daemon 关闭时调用：清理 config 文件 + 内存 token。 */
export function disposeMcpRuntime(): void {
  if (currentConfigPath) {
    try { unlinkSync(currentConfigPath); } catch { /* 已不存在 */ }
  }
  clearPerTaskMcpConfigs();
  currentToken = null;
  currentConfigPath = null;
  currentServerUrl = null;
}
