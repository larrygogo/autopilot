import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";
import { buildAuthUrl, resolveGitToken, GIT_NONINTERACTIVE_ENV } from "./workspace-health";
import type { Workspace } from "./workspaces";

// ──────────────────────────────────────────────
// 需求级代码 clone —— 澄清阶段的只读代码快照
//
// 与任务级沙盒（runtime/tasks/<id>/workspace，完整 clone、可写、交付 PR）分离：
//   runtime/requirements/<req-id>/workspace   ← 浅 clone（--depth 1），仅供 clarifier
//                                                读代码提问，不 push 不交付
// 生命周期：clarifier 首轮 ensure（幂等）；需求 done/cancelled 或删除时清理；
// failed 保留（补约束重试还要继续澄清）。
// ──────────────────────────────────────────────

const REQ_ID_RE = /^[\w.\-]+$/;
const CLONE_TIMEOUT_MS = 120_000;

export function getRequirementCloneDir(reqId: string): string {
  if (!REQ_ID_RE.test(reqId)) throw new Error(`非法 requirement ID：${reqId}`);
  return join(AUTOPILOT_HOME, "runtime", "requirements", reqId, "workspace");
}

/**
 * 确保需求级浅 clone 存在（幂等：目录非空直接返回）。
 * 失败（无远程/clone 出错/超时）返回 null —— 澄清退化为无代码模式，不阻塞主链路。
 * token 注入 + clone 后去 token 覆盖 origin（与任务沙盒同款防凭证落盘）。
 */
export async function ensureRequirementClone(
  reqId: string,
  ws: Pick<Workspace, "id" | "remote_url" | "default_branch">,
): Promise<string | null> {
  const dir = getRequirementCloneDir(reqId);
  if (existsSync(dir) && readdirSync(dir).length > 0) return dir;
  if (!ws.remote_url) return null;

  const parent = join(dir, "..");
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  let cloneUrl = ws.remote_url;
  const cleanUrl = ws.remote_url;
  try {
    const gitToken = resolveGitToken(); // config git.token > gh auth token 兜底（私有仓库）
    if (gitToken) cloneUrl = buildAuthUrl(ws.remote_url, gitToken);
  } catch { /* token 解析失败：尝试无凭证 clone */ }

  try {
    const proc = Bun.spawn(
      ["git", "clone", "--depth", "1", "--single-branch", "-b", ws.default_branch, cloneUrl, dir],
      {
        stdout: "pipe", stderr: "pipe",
        // 非交互：凭证缺失快速失败，不挂死等终端/弹窗
        env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
      },
    );
    const killTimer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, CLONE_TIMEOUT_MS);
    const exit = await proc.exited;
    clearTimeout(killTimer);
    if (exit !== 0) {
      const stderr = (await new Response(proc.stderr).text())
        .replace(cloneUrl, cleanUrl); // 脱敏
      log.warn("需求级浅 clone 失败 [req=%s ws=%s exit=%d]: %s",
        reqId, ws.id, exit, stderr.slice(0, 300));
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
  } catch (e: unknown) {
    log.warn("需求级浅 clone 异常 [req=%s]: %s", reqId, e instanceof Error ? e.message : String(e));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }

  // 去 token 覆盖 origin，防凭证明文持久化
  if (cloneUrl !== cleanUrl) {
    Bun.spawnSync(["git", "-C", dir, "remote", "set-url", "origin", cleanUrl], { stderr: "pipe" });
  }
  log.info("需求级浅 clone 创建 [req=%s ws=%s branch=%s]", reqId, ws.id, ws.default_branch);
  return dir;
}

/** 清理需求级 clone（整个 runtime/requirements/<reqId>/ 目录）。不存在时 no-op。 */
export function deleteRequirementClone(reqId: string): boolean {
  if (!REQ_ID_RE.test(reqId)) return false;
  const root = join(AUTOPILOT_HOME, "runtime", "requirements", reqId);
  if (!existsSync(root)) return false;
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch (e: unknown) {
    log.warn("清理需求级 clone 失败 [req=%s]: %s", reqId, e instanceof Error ? e.message : String(e));
    return false;
  }
}
