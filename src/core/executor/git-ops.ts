import { buildAuthUrl, GIT_NONINTERACTIVE_ENV } from "../sandbox/workspace-health";

/** 同步跑 git；check=true 时非零退出抛错。返回 {stdout,stderr,exitCode}。 */
export function runGit(args: string[], cwd: string, check = true): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
  const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).trim();
  const exitCode = proc.exitCode ?? 0;
  if (check && exitCode !== 0) throw new Error(`git 命令失败：git ${args.join(" ")}\nstderr: ${stderr}`);
  return { stdout, stderr, exitCode };
}

/** 相对 origin/<base> 是否有未交付改动（暂存/工作树脏 或 已领先提交）。 */
export function hasChanges(cwd: string, base: string): boolean {
  runGit(["add", "-A"], cwd, false);
  const dirty = runGit(["diff", "--cached", "--quiet", `origin/${base}`], cwd, false).exitCode !== 0;
  const ahead = runGit(["rev-list", "--count", `origin/${base}..HEAD`], cwd, false).stdout.trim() !== "0";
  return dirty || ahead;
}

/** 相对 origin/<base> 的 diff 统计（暂存 + 已提交都纳入，截断 3000）。 */
export function diffStat(cwd: string, base: string): string {
  // 已暂存但未提交的 diff（add -A 后 / commit 前场景）
  const staged = runGit(["diff", "--cached", "--stat", `origin/${base}`], cwd, false).stdout;
  // 已提交但未推的 diff（commit 后场景）
  const committed = runGit(["diff", "--stat", `origin/${base}...HEAD`], cwd, false).stdout;
  return (staged || committed).slice(0, 3000);
}

/**
 * 推交付分支到远程：注入 token 走 buildAuthUrl 拼临时 auth URL 直接 push 到该 URL，
 * **不碰 origin**（零痕迹，无需用后抹除 origin）。token=null 时用 remoteUrl 原样（公开仓/file://）。
 */
export function pushToRemote(cwd: string, remoteUrl: string, branch: string, token: string | null): void {
  const target = token ? buildAuthUrl(remoteUrl, token) : remoteUrl;
  const r = Bun.spawnSync(["git", "push", target, `HEAD:refs/heads/${branch}`], {
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
    Bun.spawnSync(["gh", "pr", "edit", "--body", i.body], { cwd, env });
    return parsed.url ?? "";
  }
  const created = Bun.spawnSync(["gh", ...buildGhPrArgs(i)], { cwd, stderr: "pipe", env });
  if ((created.exitCode ?? 0) !== 0) {
    throw new Error(`创建 PR 失败：${new TextDecoder().decode(created.stderr ?? new Uint8Array()).trim()}`);
  }
  return new TextDecoder().decode(created.stdout ?? new Uint8Array()).trim();
}
