// ──────────────────────────────────────────────
// per-task MCP 配置派生
//
// 地基：AsyncLocalStorage 不跨 HTTP 请求边界——claude 子进程回连 /mcp 是独立 inbound
// 请求，工具 handler 里的 getTaskContext() 永远是 undefined。所以 taskId 必须经 HTTP
// header 显式透传。本模块从 daemon 写的全局 mcp-config.json 派生一份「带 task 标识
// header」的 per-task 配置，复用已验证的 headers 通道（与 Authorization 同款）。
// inbound 侧（routes /mcp）据这两个 header 用 runWithTaskContext 重建上下文。
// ──────────────────────────────────────────────

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";

/** per-task 配置目录（含 bearer token，daemon 启停时清理）。 */
export function perTaskMcpConfigDir(): string {
  return join(AUTOPILOT_HOME, "runtime", "mcp-task-configs");
}

/** taskId 入文件名前清洗（task id 是 8 位短 id，防御性处理异常字符）。 */
function safeFileStem(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * 从全局 mcp-config.json 派生一份带 task 标识 header 的 per-task 配置，写盘并返回路径。
 *
 * @param basePath 全局 mcp-config.json 路径
 * @param taskId 当前 task（经 X-Autopilot-Task header 透传给 inbound /mcp）
 * @param phase 当前 phase（经 X-Autopilot-Phase header 透传；可空）
 * @param dir 输出目录（缺省 perTaskMcpConfigDir()；测试可注入临时目录）
 */
export function writePerTaskMcpConfig(
  basePath: string,
  taskId: string,
  phase: string,
  dir: string = perTaskMcpConfigDir(),
): string {
  const raw = JSON.parse(readFileSync(basePath, "utf-8")) as {
    mcpServers?: Record<string, { headers?: Record<string, string> }>;
  };
  const server = raw.mcpServers?.autopilot;
  if (server) {
    server.headers = {
      ...(server.headers ?? {}),
      "X-Autopilot-Task": taskId,
      "X-Autopilot-Phase": phase,
    };
  }
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${safeFileStem(taskId)}.json`);
  // 文件含 bearer token，0o600 仅 owner 可读写（与全局 config 同策）。
  writeFileSync(out, JSON.stringify(raw, null, 2), { encoding: "utf-8", mode: 0o600 });
  return out;
}

/** daemon 启动/关闭时清理 per-task 配置目录（含 token 残留文件）。 */
export function clearPerTaskMcpConfigs(): void {
  try {
    rmSync(perTaskMcpConfigDir(), { recursive: true, force: true });
  } catch {
    /* 不存在即忽略 */
  }
}
