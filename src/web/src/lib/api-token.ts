/**
 * 浏览器侧 API token 存储 — 仅用于"从局域网网卡进来的浏览器"。
 *
 * 本机回环（127.0.0.1 / localhost）访问 daemon 时服务端会自动豁免 token，
 * 此 module 返回的 token 不会被塞进 header；只有从局域网 IP 访问时才需要。
 *
 * 存储位置：localStorage["autopilot.apiToken"]。被恶意脚本读到不可避免，
 * 但 autopilot 的威胁模型本就把"客户端机器可信"作为基线。
 */

const STORAGE_KEY = "autopilot.apiToken";

export function getApiToken(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

export function setApiToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  if (!token) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, token);
}

export function clearApiToken(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}

/** 判定是否处于"需要 token"的场景 —— 非 127.x / localhost 访问时返回 true */
export function shouldUseToken(): boolean {
  if (typeof location === "undefined") return false;
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return false;
  if (host === "::1" || host === "[::1]") return false;
  return true;
}
