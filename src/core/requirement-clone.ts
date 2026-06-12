import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";
import { buildAuthUrl, resolveGitToken, GIT_NONINTERACTIVE_ENV } from "./workspace-health";
import { safeAliasDir } from "./sandbox";
import type { Workspace } from "./workspaces";

// ──────────────────────────────────────────────
// 需求级代码 clone —— 澄清阶段的只读代码快照
//
// 与任务级沙盒（runtime/tasks/<id>/workspace，完整 clone、可写、交付 PR）分离：
//   runtime/requirements/<req-id>/workspace/<alias>/   ← 浅 clone（--depth 1），仅供 clarifier
//                                                        读代码提问，不 push 不交付
// 需求全集多库：每个关联代码库 clone 到 workspace/ 下独立子目录（单库 = 长度 1 列表，
// 同一布局）。子目录名 = safeAliasDir(alias)（与任务沙盒同款净化；撞名/非法回退 ws.id）。
// 生命周期：clarifier 首轮 ensure（幂等）；需求 done/cancelled 或删除时清理；
// failed 保留（补约束重试还要继续澄清）。
// ──────────────────────────────────────────────

const REQ_ID_RE = /^[\w.\-]+$/;
const DEFAULT_CLONE_TIMEOUT_MS = 120_000;

/** ensureRequirementClones 接受的最小 workspace 形状（测试夹具友好） */
export type RequirementCloneWorkspace = Pick<Workspace, "id" | "remote_url" | "default_branch"> & {
  alias?: string | null;
};

export function getRequirementCloneDir(reqId: string): string {
  if (!REQ_ID_RE.test(reqId)) throw new Error(`非法 requirement ID：${reqId}`);
  return join(AUTOPILOT_HOME, "runtime", "requirements", reqId, "workspace");
}

/**
 * 确保需求全集代码库的浅 clone 存在（逐库幂等：子目录非空直接复用；各库并行 clone）。
 * 按库降级：单库失败只进 failed（无远程 / clone 出错 / 超时），不拖垮其余库——
 * 澄清只读，半套布局无害（与任务沙盒「任一失败整体退化」有意不同）。
 * 旧单库平铺布局（workspace/.git 存在）→ 整目录删除重建（暂态缓存，不写双格式 reader）。
 * token 注入 + clone 后去 token 覆盖 origin（与任务沙盒同款防凭证落盘）。
 */
export async function ensureRequirementClones<W extends RequirementCloneWorkspace>(
  reqId: string,
  wsList: W[],
  opts?: { timeoutMs?: number },
): Promise<{ root: string; cloned: Array<{ ws: W; dir: string; path: string }>; failed: W[] }> {
  const root = getRequirementCloneDir(reqId);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;

  // 旧单库平铺布局检测：root 本身是仓库根 → 整目录重建
  if (existsSync(join(root, ".git"))) {
    log.info("需求级 clone 检测到旧平铺布局，整目录重建 [req=%s]", reqId);
    rmSync(root, { recursive: true, force: true });
  }
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  // 子目录名先顺序分配定死（撞名回退 ws.id），再并行 clone
  const usedDirs = new Set<string>();
  const entries = wsList.map((ws) => {
    let dir = safeAliasDir(ws.alias ?? ws.id, ws.id);
    if (usedDirs.has(dir)) dir = ws.id;
    usedDirs.add(dir);
    return { ws, dir, path: join(root, dir) };
  });

  const cloned: Array<{ ws: W; dir: string; path: string }> = [];
  const failed: W[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const ok = await cloneOne(reqId, entry.ws, entry.path, timeoutMs);
      if (ok) cloned.push(entry);
      else failed.push(entry.ws);
    }),
  );

  // 并行完成顺序不定 → 按入参顺序回排，调用方拿到稳定布局
  const order = new Map(entries.map((e, i) => [e.ws.id, i]));
  cloned.sort((a, b) => (order.get(a.ws.id) ?? 0) - (order.get(b.ws.id) ?? 0));
  failed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return { root, cloned, failed };
}

/** 单库浅 clone（幂等：目标子目录非空直接复用）。失败清残留目录，返回 false。 */
async function cloneOne(
  reqId: string,
  ws: RequirementCloneWorkspace,
  dest: string,
  timeoutMs: number,
): Promise<boolean> {
  if (existsSync(dest) && readdirSync(dest).length > 0) return true;
  if (!ws.remote_url) return false;
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

  let cloneUrl = ws.remote_url;
  const cleanUrl = ws.remote_url;
  try {
    const gitToken = resolveGitToken(); // config git.token > gh auth token 兜底（私有仓库）
    if (gitToken) cloneUrl = buildAuthUrl(ws.remote_url, gitToken);
  } catch { /* token 解析失败：尝试无凭证 clone */ }

  try {
    const proc = Bun.spawn(
      ["git", "clone", "--depth", "1", "--single-branch", "-b", ws.default_branch, cloneUrl, dest],
      {
        stdout: "pipe", stderr: "pipe",
        // 非交互：凭证缺失快速失败，不挂死等终端/弹窗
        env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
      },
    );
    const killTimer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
    const exit = await proc.exited;
    clearTimeout(killTimer);
    if (exit !== 0) {
      const stderr = (await new Response(proc.stderr).text())
        .replace(cloneUrl, cleanUrl); // 脱敏
      log.warn("需求级浅 clone 失败 [req=%s ws=%s exit=%d]: %s",
        reqId, ws.id, exit, stderr.slice(0, 300));
      rmSync(dest, { recursive: true, force: true });
      return false;
    }
  } catch (e: unknown) {
    log.warn("需求级浅 clone 异常 [req=%s ws=%s]: %s", reqId, ws.id, e instanceof Error ? e.message : String(e));
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
    return false;
  }

  // 去 token 覆盖 origin，防凭证明文持久化
  if (cloneUrl !== cleanUrl) {
    Bun.spawnSync(["git", "-C", dest, "remote", "set-url", "origin", cleanUrl], { stderr: "pipe" });
  }
  log.info("需求级浅 clone 创建 [req=%s ws=%s branch=%s]", reqId, ws.id, ws.default_branch);
  return true;
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
