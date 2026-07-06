/**
 * selfhosted-connector 凭证管理（落盘 AUTOPILOT_HOME/selfhosted/credentials.json）
 *
 * 与 runner/credentials.ts 结构相同，路径独立（selfhosted/ 子目录），
 * 便于 selfhosted 与 A 模式 runner 凭证共存。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "node:child_process";
import { AUTOPILOT_HOME } from "../../index";
import { log } from "../../core/logger";
import type { SelfhostedCredentials } from "./types";

function home(): string {
  return process.env.AUTOPILOT_HOME || AUTOPILOT_HOME;
}

/** selfhosted 凭证落盘路径：AUTOPILOT_HOME/selfhosted/credentials.json */
export function selfhostedCredentialsPath(): string {
  return join(home(), "selfhosted", "credentials.json");
}

/**
 * 平台 ACL 收紧（同 runner/credentials.ts 策略）。
 * POSIX: chmod 0o600；Windows: icacls /inheritance:r + 当前用户完全控制。
 * best-effort：失败只 warn，不抛。
 */
function restrictFileAcl(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (process.platform === "win32") {
      const domain = process.env.USERDOMAIN ?? "";
      const user = process.env.USERNAME
        ? `${domain}\\${process.env.USERNAME}`.replace(/^\\/, "")
        : null;
      const r = spawnSync("icacls", [path, "/inheritance:r"], { windowsHide: true, stdio: "ignore" });
      if ((r.status ?? 0) !== 0) {
        log.warn("selfhosted 凭证 ACL 去继承失败（icacls）：%s", path);
        return;
      }
      if (user) {
        spawnSync("icacls", [path, "/grant:r", `${user}:F`], { windowsHide: true, stdio: "ignore" });
      }
    } else {
      chmodSync(path, 0o600);
    }
  } catch (e: unknown) {
    log.warn("selfhosted 凭证 ACL 收紧失败（忽略）：%s", e instanceof Error ? e.message : String(e));
  }
}

/** 读取落盘凭证；未注册返回 null。 */
export function loadSelfhostedCredentials(): SelfhostedCredentials | null {
  const p = selfhostedCredentialsPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as SelfhostedCredentials;
    if (
      typeof raw?.instance_id === "string" &&
      typeof raw?.secret === "string" &&
      typeof raw?.control_plane_url === "string"
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/** 写凭证到 selfhosted/credentials.json + 收紧 ACL。 */
export function saveSelfhostedCredentials(c: SelfhostedCredentials): void {
  const p = selfhostedCredentialsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
  restrictFileAcl(p);
}

/** 删凭证（remove 命令用）；不存在返回 false。 */
export function clearSelfhostedCredentials(): boolean {
  const p = selfhostedCredentialsPath();
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
