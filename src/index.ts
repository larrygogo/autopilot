import { homedir } from "os";
import { join, dirname } from "path";
import { execFileSync } from "child_process";

export const VERSION = "1.0.0";
export const AUTOPILOT_HOME = process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");

/**
 * 当前代码的 git 短 SHA。daemon 启动时一次性读取并缓存。
 * - 取仓库根（src/index.ts 的祖父目录）跑 `git rev-parse --short HEAD`
 * - 用 execFileSync 不走 shell（无注入风险，固定参数）
 * - 非 git 仓库 / git 不在 PATH / 任何异常 → 返回 "dev"
 *
 * 用途：让 web 决策者 panel restart 完能 verify "现在跑的是新代码还是旧代码"，
 * 不必跳到终端 ps / 看日志（CLAUDE.md「产品分层定位」原则）。
 */
function detectGitSha(): string {
  try {
    const here = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const repoRoot = dirname(dirname(here));
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).toString().trim();
    return sha || "dev";
  } catch {
    return "dev";
  }
}

export const GIT_SHA = detectGitSha();
export const STARTED_AT_ISO = new Date().toISOString();
