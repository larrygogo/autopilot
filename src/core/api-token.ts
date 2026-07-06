import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import { AUTOPILOT_HOME } from "../index";

/**
 * API token 持久化 —— 用于 daemon 暴露 0.0.0.0 时强制鉴权。
 *
 * 设计：
 *   - 独立文件 <AUTOPILOT_HOME>/runtime/api-token，权限 0600（仅 owner 可读写）
 *   - 不写入 config.json（用户经常截图 / 贴日志 config.json）
 *   - 取值优先级在调用方：env AUTOPILOT_API_TOKEN > 此文件 > 空
 *   - 删除文件 = 关闭 token 鉴权
 *
 * 路径每次调用时重算（process.env.AUTOPILOT_HOME 优先 / 兜底 AUTOPILOT_HOME
 * 常量），便于测试用 tmpdir 隔离。daemon 运行期间 env 通常不变，行为等价。
 */

function tokenFilePath(): string {
  return join(process.env.AUTOPILOT_HOME || AUTOPILOT_HOME, "runtime", "api-token");
}

export function getTokenFilePath(): string {
  return tokenFilePath();
}

/** 读取文件中的 token。不存在或为空返回 null。 */
export function loadApiToken(): string | null {
  const path = tokenFilePath();
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** 写入 token + 设置 0600 权限。Windows 上 chmod 是 no-op。 */
export function saveApiToken(token: string): void {
  const path = tokenFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, "utf-8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows 或权限不足时忽略 */
  }
}

/** 删除 token 文件 = 关闭鉴权。文件不存在也 OK。 */
export function deleteApiToken(): void {
  try {
    unlinkSync(tokenFilePath());
  } catch {
    /* ignore */
  }
}

/** 生成 32 字节随机 token，base64url 编码（约 43 字符，URL 安全）。 */
export function generateApiToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 给 token 做"前 4 后 4 中间 ***"预览。
 * 用于 UI 展示已设置的 token 状态而不暴露完整值。
 */
export function previewApiToken(token: string): string {
  if (token.length <= 12) return "********";
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}
