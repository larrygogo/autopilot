import { runGit, hasChanges, diffStat, pushToRemote, openOrUpdatePr } from "./git-ops";

/**
 * dev 阶段：相对 origin/<base> 产 diff（不提交不推送）。空改动返回 ""。
 * 无副作用：用 `git add -N` 让未跟踪文件进 diff，产出后 `git reset` 还原 index。
 * 前置：调用前 origin/<base> 须存在（由 ensureCodebase 保证）。
 */
export function produceDiff(cwd: string, base: string): string {
  runGit(["add", "-N", "."], cwd, false); // intent-to-add：让未跟踪文件进 diff
  const out = runGit(["diff", `origin/${base}`], cwd, false).stdout;
  runGit(["reset", "-q"], cwd, false); // 还原 intent-to-add，保持 produceDiff 无副作用
  return out;
}

export interface ExecRepo {
  path: string;
  remoteUrl: string;
  branch: string;
  base: string;
  primary: boolean;
  label: string;
}
export interface SubmitPrOpts {
  title: string;
  /** 按库生成 PR body（diffStat 由调用方决定是否拼入）。 */
  bodyFor: (repo: ExecRepo, diffStatText: string) => string;
  gitToken: string | null;
  /** 注入点（测试可桩）：默认走 openOrUpdatePr。 */
  openPr?: (cwd: string, repo: ExecRepo, body: string) => string;
}
export interface SubmitPrResult {
  results: Array<{ repo: ExecRepo; prUrl: string; prNumber: number }>;
  failures: string[];
}

/**
 * pr 阶段纯核：逐库 commit+push+开 PR，返回纯数据。
 * **无任何 DB / transition / appendSubPr 副作用**——那些留给调用方（workflow 层 / runner 外壳）。
 */
export async function submitPrPure(repos: ExecRepo[], opts: SubmitPrOpts): Promise<SubmitPrResult> {
  const results: SubmitPrResult["results"] = [];
  const failures: string[] = [];
  for (const r of repos) {
    try {
      if (!hasChanges(r.path, r.base)) continue; // 无改动不开空 PR
      // hasChanges 已暂存；此处显式 add -A 保证语义不依赖其副作用
      runGit(["add", "-A"], r.path);
      runGit(["commit", "-m", `feat: ${opts.title}`], r.path, false);
      pushToRemote(r.path, r.remoteUrl, r.branch, opts.gitToken);
      const body = opts.bodyFor(r, diffStat(r.path, r.base));
      const prUrl = opts.openPr
        ? opts.openPr(r.path, r, body)
        : openOrUpdatePr(r.path, { title: opts.title, body, base: r.base, head: r.branch }, opts.gitToken);
      const prNumber = Number(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? 0);
      results.push({ repo: r, prUrl, prNumber });
    } catch (e: unknown) {
      failures.push(`[${r.label}] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { results, failures };
}
