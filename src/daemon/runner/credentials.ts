import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "node:child_process";
import { AUTOPILOT_HOME } from "../../index";
import { log } from "../../core/logger";
import type { RunnerCredentials } from "./types";

function home(): string {
  return process.env.AUTOPILOT_HOME || AUTOPILOT_HOME;
}

/** runner 凭证落盘路径 AUTOPILOT_HOME/runner/credentials.json。 */
export function credentialsPath(): string {
  return join(home(), "runner", "credentials.json");
}

/**
 * 平台 ACL 收紧：解决 auth.ts:33 同款弱点（NTFS 上 chmod 0o600 无效，任意本机用户可读凭证）。
 * - POSIX：chmod 0o600。
 * - Windows：icacls /inheritance:r 去继承 + 仅授当前用户完全控制。
 * best-effort：文件不存在或命令失败只 warn，不抛（凭证写入本身已成功，ACL 是纵深防御）。
 */
export function restrictFileAcl(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (process.platform === "win32") {
      const domain = process.env.USERDOMAIN ?? "";
      const user = process.env.USERNAME
        ? `${domain}\\${process.env.USERNAME}`.replace(/^\\/, "")
        : null;
      const r = spawnSync("icacls", [path, "/inheritance:r"], { windowsHide: true, stdio: "ignore" });
      if ((r.status ?? 0) !== 0) {
        log.warn("runner 凭证 ACL 去继承失败（icacls）：%s", path);
        return;
      }
      if (user) {
        spawnSync("icacls", [path, "/grant:r", `${user}:F`], { windowsHide: true, stdio: "ignore" });
      }
    } else {
      chmodSync(path, 0o600);
    }
  } catch (e: unknown) {
    log.warn("runner 凭证 ACL 收紧失败（忽略）：%s", e instanceof Error ? e.message : String(e));
  }
}

/** 读取落盘凭证；未注册返回 null。 */
export function loadCredentials(): RunnerCredentials | null {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as RunnerCredentials;
    if (
      typeof raw?.runner_id === "string" &&
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

/** 写凭证到 runner/credentials.json + 收紧 ACL。 */
export function saveCredentials(c: RunnerCredentials): void {
  const p = credentialsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
  restrictFileAcl(p);
}

/** 删凭证（remove 命令用）；不存在返回 false。 */
export function clearCredentials(): boolean {
  const p = credentialsPath();
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
