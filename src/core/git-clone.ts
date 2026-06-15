import { existsSync, appendFileSync } from "fs";
import { join } from "path";
import { log } from "./logger";

/**
 * clone 完成后的共享收尾（sync）：建/续交付分支 + 写 `.git/info/exclude`。
 *
 * 由两条 clone 路径共用，消除重复的 checkout 逻辑（architect 2026-06-15 审查 H2：
 * codebase.ts 的 cloneRepo 与 sandbox.ts 的 cloneOneRepo 这段曾逐行重复、改一处忘改另一处）：
 *   - `codebase.ts`（需求级 codebase，生产路径）— full clone 后调
 *   - `sandbox.ts`（legacy 任务沙盒，测试覆盖）— clone 后调
 *
 * 约定：调用前 clone 已成功、origin 已去 token。base/branch 语义见各调用点。
 *   checkoutExisting=true → fix run 续作：checkout 既有远程交付分支，远程没有则停默认分支只读参考。
 *   checkoutExisting=false → 从 origin/<base> 新建交付分支。
 * 任一步失败仅 warn 不抛（仍在克隆的默认分支，尽量跑）。
 */
export function finalizeDeliveryClone(
  dest: string,
  opts: { base: string; branch: string; checkoutExisting?: boolean; logCtx?: string },
): void {
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dest, ...a], { stdout: "pipe", stderr: "pipe" });
  const ctx = opts.logCtx ?? dest;
  const errText = (p: ReturnType<typeof Bun.spawnSync>) =>
    new TextDecoder().decode(p.stderr ?? new Uint8Array()).slice(0, 200);

  if (opts.checkoutExisting) {
    // fix run 续作模式（v2 R3）：checkout 既有远程交付分支，不从 base 新建（不重置交付内容）。
    // 远程无此分支 = 该库本轮无交付 PR → 停在克隆的默认分支只读参考，不视为失败。
    const hasRemote = git("rev-parse", "--verify", "--quiet", `origin/${opts.branch}`).exitCode === 0;
    if (hasRemote) {
      const co = git("checkout", "-B", opts.branch, `origin/${opts.branch}`);
      if (co.exitCode !== 0) {
        log.warn("checkout 既有交付分支失败 [%s branch=%s]: %s", ctx, opts.branch, errText(co));
      }
    } else {
      log.info("远程无交付分支 %s，保持默认分支（该库本轮无交付，只读参考）[%s]", opts.branch, ctx);
    }
  } else {
    // 基于 origin/<base> 建交付分支（完整 clone 后所有分支均作为 origin/<x> 可用）
    const baseRef = git("rev-parse", "--verify", "--quiet", `origin/${opts.base}`).exitCode === 0
      ? `origin/${opts.base}` : opts.base;
    const co = git("checkout", "-B", opts.branch, baseRef);
    if (co.exitCode !== 0) {
      log.warn("clone 后建交付分支失败 [%s branch=%s base=%s]: %s", ctx, opts.branch, opts.base, errText(co));
      // 不致命：仍在克隆的默认分支，尽量跑
    }
  }

  // .git/info/exclude：让阶段产物目录不进 PR
  try {
    const excludeFile = join(dest, ".git", "info", "exclude");
    if (existsSync(join(dest, ".git", "info"))) {
      appendFileSync(excludeFile, "\n# autopilot 阶段产物（不进交付 PR）\n/[0-9][0-9]-*/\n");
    }
  } catch { /* exclude 写失败不阻塞任务 */ }
}
