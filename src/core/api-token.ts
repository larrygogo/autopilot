import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import { AUTOPILOT_HOME } from "../index";

/**
 * API token 持久化 —— 用于 daemon 暴露 0.0.0.0 时强制鉴权。
 *
 * 设计：
 *   - 独立文件 ~/.autopilot/runtime/api-token，权限 0600（仅 owner 可读写）
 *   - 不写入 config.yaml（用户经常截图 / 贴日志 config.yaml）
 *   - 取值优先级在调用方：env AUTOPILOT_API_TOKEN > 此文件 > 空
 *   - 删除文件 = 关闭 token 鉴权
 */

const TOKEN_FILE = join(AUTOPILOT_HOME, "runtime", "api-token");

export function getTokenFilePath(): string {
  return TOKEN_FILE;
}

/** 读取文件中的 token。不存在或为空返回 null。 */
export function loadApiToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const content = readFileSync(TOKEN_FILE, "utf-8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** 写入 token + 设置 0600 权限。Windows 上 chmod 是 no-op。 */
export function saveApiToken(token: string): void {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token, "utf-8");
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    /* Windows 或权限不足时忽略 */
  }
}

/** 删除 token 文件 = 关闭鉴权。文件不存在也 OK。 */
export function deleteApiToken(): void {
  try {
    unlinkSync(TOKEN_FILE);
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
