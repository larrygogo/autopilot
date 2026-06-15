import { existsSync, rmSync } from "fs";
import { log } from "../logger";
import {
  ensureCodebase,
  deleteRequirementCodebase,
  getRequirementCodebaseRoot,
  getRequirementDir,
  type CodebaseFidelity,
} from "../codebase";
import type { Workspace } from "../workspaces";

// ──────────────────────────────────────────────
// 需求级代码 clone —— 澄清阶段入口（v2 R4 起是 ensureCodebase 的薄壳）
//
// clone 归需求所有（runtime/requirements/<reqId>/codebase/<alias>/，清单 .codebase.json），
// 澄清浅 clone 与执行完整 clone 同一份：本模块保留澄清侧的历史入口名，
// 全部委托 src/core/codebase.ts 的 ensureCodebase(fidelity="shallow")。
//
// 生命周期：clarifier 首轮 ensure（幂等）；需求 done 清理（done-workspace-cleanup）、
// cancelled 仅清纯浅 clone（full 留给 retention 按需求终态清）；删除需求整树删。
// failed 保留（补约束重试还要继续澄清；fix run 还要复用交付分支工作树）。
// ──────────────────────────────────────────────

const REQ_ID_RE = /^[\w.\-]+$/;

/** ensureRequirementClones 接受的最小 workspace 形状（测试夹具友好） */
export type RequirementCloneWorkspace = Pick<Workspace, "id" | "remote_url" | "default_branch"> & {
  alias?: string | null;
};

/** 需求代码 clone 根目录（= 需求级 codebase 根，v2 R4 起）。 */
export function getRequirementCloneDir(reqId: string): string {
  return getRequirementCodebaseRoot(reqId);
}

/**
 * 确保需求全集代码库的浅 clone 存在（逐库幂等、按库降级：单库失败只进 failed，
 * 不拖垮其余库——澄清只读，半套布局无害）。
 *
 * v2 R4：委托 ensureCodebase(fidelity="shallow")。既有 full clone（上一轮执行的交付分支
 * 工作树）直接复用——返回条目带 fidelity/branch，调用方（clarifier）在 prompt 里如实声明
 * 交付分支现场，不静默 reset。
 */
export async function ensureRequirementClones<W extends RequirementCloneWorkspace>(
  reqId: string,
  wsList: W[],
  opts?: { timeoutMs?: number },
): Promise<{
  root: string;
  cloned: Array<{ ws: W; dir: string; path: string; fidelity: CodebaseFidelity; branch: string }>;
  failed: W[];
}> {
  const r = await ensureCodebase(reqId, wsList, { fidelity: "shallow", timeoutMs: opts?.timeoutMs });
  return {
    root: r.root,
    cloned: r.repos.map((c) => ({ ws: c.ws, dir: c.dir, path: c.path, fidelity: c.fidelity, branch: c.branch })),
    failed: r.failed,
  };
}

/**
 * 清理需求级代码 clone（= 清 codebase/ + 清单 + 旧 workspace/ 布局）。不存在时 no-op。
 * 不动 runs/ 执行历史——整树删除走 deleteRequirementRuntimeDir（仅"删除需求"路径）。
 */
export function deleteRequirementClone(reqId: string): boolean {
  if (!REQ_ID_RE.test(reqId)) return false;
  return deleteRequirementCodebase(reqId);
}

/**
 * 删除需求的整个运行时目录 runtime/requirements/<reqId>/（含 codebase/ 代码 clone 与
 * runs/ 执行历史）。仅供"删除需求"级联清理使用——其余生命周期点（done/cancelled）
 * 只清代码 clone（deleteRequirementClone / deleteRequirementCodebase）。
 */
export function deleteRequirementRuntimeDir(reqId: string): boolean {
  if (!REQ_ID_RE.test(reqId)) return false;
  const root = getRequirementDir(reqId);
  if (!existsSync(root)) return false;
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch (e: unknown) {
    log.warn("删除需求运行时目录失败 [req=%s]: %s", reqId, e instanceof Error ? e.message : String(e));
    return false;
  }
}
