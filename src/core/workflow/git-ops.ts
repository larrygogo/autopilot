import { buildAuthUrl, GIT_NONINTERACTIVE_ENV } from "../sandbox/workspace-health";

/** 同步跑 git（带非交互 env 防凭证场景挂死）；check=true 时非零退出抛错。返回 {stdout,stderr,exitCode}。 */
export function runGit(args: string[], cwd: string, check = true): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", env: { ...process.env, ...GIT_NONINTERACTIVE_ENV } });
  const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
  const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).trim();
  const exitCode = proc.exitCode ?? 0;
  if (check && exitCode !== 0) throw new Error(`git 命令失败：git ${args.join(" ")}\nstderr: ${stderr}`);
  return { stdout, stderr, exitCode };
}

/**
 * 相对 origin/<base> 是否有未交付改动（暂存/工作树脏 或 已领先提交）。
 * 注意：内部执行 `git add -A`，会修改 index。
 */
export function hasChanges(cwd: string, base: string): boolean {
  runGit(["add", "-A"], cwd, false);
  const dirty = runGit(["diff", "--cached", "--quiet", `origin/${base}`], cwd, false).exitCode !== 0;
  const ahead = runGit(["rev-list", "--count", `origin/${base}..HEAD`], cwd, false).stdout.trim() !== "0";
  return dirty || ahead;
}

/** 相对 origin/<base> 的**已提交**改动统计（commit 后调用，截断 3000）。 */
export function diffStat(cwd: string, base: string): string {
  return runGit(["diff", `origin/${base}...HEAD`, "--stat"], cwd, false).stdout.slice(0, 3000);
}

/**
 * 推交付分支到远程：注入 token 走 buildAuthUrl 拼临时 auth URL 直接 push 到该 URL，
 * **不碰 origin**（零痕迹，无需用后抹除 origin）。token=null 时用 remoteUrl 原样
 * （公开仓/file://，**也可是已配置的 remote 别名如 "origin"**——git 当别名解析，
 * builtin-deliver-pr 在 remote_url=null 时正是传 "origin"）。
 *
 * refspec 用**显式本地分支** `refs/heads/<branch>:refs/heads/<branch>` 而非 `HEAD:...`：
 * ensureCodebase/git-clone 的 `checkout -B <branch>` 是 warn-only 不抛错，若 checkout 失败
 * HEAD 会停在默认分支——用 HEAD 会把默认分支内容**静默推上交付分支**（错误内容、静默成功）；
 * 推显式本地分支则在本地无该分支时 git push 失败，恢复「安全失败」语义。
 */
export function pushToRemote(cwd: string, remoteUrl: string, branch: string, token: string | null): void {
  const target = token ? buildAuthUrl(remoteUrl, token) : remoteUrl;
  const r = Bun.spawnSync(["git", "push", target, `refs/heads/${branch}:refs/heads/${branch}`], {
    cwd, stderr: "pipe", env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
  });
  if ((r.exitCode ?? 0) !== 0) {
    const stderr = new TextDecoder().decode(r.stderr ?? new Uint8Array()).trim().replaceAll(target, remoteUrl);
    throw new Error(`git push 失败（分支 ${branch}）：${stderr}`);
  }
}

export interface GhPrInput { title: string; body: string; base: string; head: string; }
/** 纯函数：拼 gh pr create 的 argv（便于单测，不含 token）。 */
export function buildGhPrArgs(i: GhPrInput): string[] {
  return ["pr", "create", "--title", i.title, "--body", i.body, "--base", i.base, "--head", i.head];
}

/** gh pr view 判 OPEN 则更新 body 返回其 url，否则 create。token 经 GH_TOKEN env 注入。失败抛错。 */
export function openOrUpdatePr(cwd: string, i: GhPrInput, token: string | null): string {
  const env = token ? { ...process.env, GH_TOKEN: token } : { ...process.env };
  const view = Bun.spawnSync(["gh", "pr", "view", "--json", "url,state"], { cwd, stderr: "pipe", env });
  const out = new TextDecoder().decode(view.stdout ?? new Uint8Array()).trim();
  let parsed: { url?: string; state?: string } | null = null;
  if (view.exitCode === 0 && out) { try { parsed = JSON.parse(out); } catch { parsed = null; } }
  if (parsed?.state === "OPEN") {
    const edited = Bun.spawnSync(["gh", "pr", "edit", "--body", i.body], { cwd, stderr: "pipe", env });
    if ((edited.exitCode ?? 0) !== 0) {
      throw new Error(`更新 PR 失败：${new TextDecoder().decode(edited.stderr ?? new Uint8Array()).trim()}`);
    }
    return parsed.url ?? "";
  }
  const created = Bun.spawnSync(["gh", ...buildGhPrArgs(i)], { cwd, stderr: "pipe", env });
  if ((created.exitCode ?? 0) !== 0) {
    throw new Error(`创建 PR 失败：${new TextDecoder().decode(created.stderr ?? new Uint8Array()).trim()}`);
  }
  return new TextDecoder().decode(created.stdout ?? new Uint8Array()).trim();
}
