import { execFile } from "node:child_process";
import { join } from "node:path";
import type { UpdateInfo } from "../daemon/protocol";

// ──────────────────────────────────────────────
// 更新检查 —— 只读判断本地代码是否落后远端，把「发现更新」从用户记忆挪到机制。
//
// 设计：用 `git ls-remote origin <branch>` 拿远端该分支 head sha（纯网络读、零本地写入，
// 不 fetch、不改 .git、不污染用户仓库、也不依赖用户先 fetch）。
// 判定不靠「sha 不等就 behind」（那会把「本地领先 / 有未推送 commit」误报成 behind），而是用
// `git merge-base --is-ancestor <remoteSha> HEAD`：
//   - remoteSha 能从本地 HEAD 追溯到（本地已含）→ 本地领先或最新 = current
//   - 追溯不到 / 本地没这个对象（远端有本地没有的提交）→ behind = 有更新可用
// 失败（离线 / 非 git / 无 origin）→ unknown。
// ──────────────────────────────────────────────

// 仓库根：src/core/update-check.ts → ../.. = 仓库根
const REPO_ROOT = join(import.meta.dir, "../..");

const UNKNOWN: UpdateInfo = { status: "unknown", branch: null, local_sha: null, remote_sha: null, checked_at: null };
let cached: UpdateInfo = UNKNOWN;
let inFlight: Promise<UpdateInfo> | null = null;

function git(args: string[], timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: REPO_ROOT, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

/** 当前缓存的更新状态（同步读，daemon.status 用）。 */
export function getUpdateInfo(): UpdateInfo {
  return cached;
}

/**
 * remoteSha 是否能从本地 HEAD 追溯到（本地已含该提交 = 本地领先或最新）。
 * - is-ancestor 退出 0 → true（本地有）
 * - 退出 1（明确不是祖先）或本地无此对象（远端有新提交，fatal 128）→ false（远端领先）
 * 走到这里说明 rev-parse + ls-remote 都成功，git/repo/remote 均正常，故 catch 一律当作「本地没有」。
 */
async function localHasCommit(sha: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** 只读检查一次本地 vs 远端，结果写入缓存并返回。并发调用复用同一 inflight。 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<UpdateInfo> => {
    const next: UpdateInfo = { ...UNKNOWN, checked_at: new Date().toISOString() };
    try {
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const localSha = await git(["rev-parse", "HEAD"]);
      next.branch = branch || null;
      next.local_sha = localSha || null;
      const ref = branch && branch !== "HEAD" ? branch : "HEAD";
      const out = await git(["ls-remote", "origin", ref]);
      const remoteSha = out.split(/\s+/)[0] || null;
      next.remote_sha = remoteSha;
      if (remoteSha && localSha) {
        next.status = remoteSha === localSha || (await localHasCommit(remoteSha)) ? "current" : "behind";
      }
    } catch {
      // 离线 / 非 git / 无 origin —— 保留已采集字段，status 维持 unknown
    }
    cached = next;
    return next;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
let _timer: ReturnType<typeof setInterval> | null = null;

/** daemon 启动时调起：首次检查异步跑（不阻塞启动），之后每 6h 重查。 */
export function initUpdateMonitor(): void {
  checkForUpdate().catch(() => { /* best-effort，离线不报错 */ });
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => { checkForUpdate().catch(() => {}); }, REFRESH_INTERVAL_MS);
  (_timer as { unref?: () => void }).unref?.();
}

export function disposeUpdateMonitor(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
