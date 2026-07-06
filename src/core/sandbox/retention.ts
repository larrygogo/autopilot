import { existsSync, statSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { log } from "../logger";
import { loadConfig } from "../config";
import { dirSizeBytes, tasksRootDir, requirementsRootDir, removeTaskWorktree } from "./index";

/**
 * 代码 clone 自动清理（retention）：扫占用 + 按 days / max_total_mb 清理。
 * 从 sandbox.ts 拆出的叶子模块（daemon watcher / rpc 消费；sandbox.ts 自身不依赖它，无回环）。
 *
 * 两条轨：
 *   - 旧轨：任务自有 workspace/（legacy runtime/tasks/ + runs/<id>/workspace，存量任务）—— 终态任务才清
 *   - 新轨（v2 R4）：需求级 codebase/（runtime/requirements/<reqId>/codebase/）—— 只清终态需求
 */

export interface TaskSandboxUsage {
  taskId: string;
  /** 任务运行时根目录绝对路径（双根：legacy runtime/tasks/<id> 或 requirements/<reqId>/runs/<id>） */
  root: string;
  size: number;
  mtime: number;
  exists: boolean;
}

export interface RetentionPolicy {
  /** 终态任务 sandbox 保留天数；<=0 表示永久保留 */
  days?: number;
  /** 保留磁盘占用上限 MB；超出则按 mtime 从旧到新删，直到低于上限 */
  max_total_mb?: number;
}

/**
 * 从全局 config 读 sandbox_retention 段。
 * 兼容：优先读 sandbox_retention，回退老字段 workspace_retention 并打 deprecation warning。
 */
export function loadRetentionPolicy(): RetentionPolicy {
  try {
    const raw = loadConfig();
    let section = raw["sandbox_retention"];
    if (
      (!section || typeof section !== "object") &&
      raw["workspace_retention"] &&
      typeof raw["workspace_retention"] === "object"
    ) {
      log.warn("config.json 的 `workspace_retention` 已更名为 `sandbox_retention`，请尽快迁移（本次回退读老字段）");
      section = raw["workspace_retention"];
    }
    if (!section || typeof section !== "object") return {};
    return section as RetentionPolicy;
  } catch { return {}; }
}

/** 需求级 codebase 的磁盘占用（retention 新轨，v2 R4） */
export interface RequirementCodebaseUsage {
  reqId: string;
  /** codebase/ 目录绝对路径 */
  path: string;
  size: number;
  mtime: number;
}

/** 扫所有需求级 codebase 大小 + mtime（runtime/requirements/<reqId>/codebase/）。 */
export function scanRequirementCodebases(requirementsRootOverride?: string): RequirementCodebaseUsage[] {
  const root = requirementsRootOverride ?? requirementsRootDir();
  const out: RequirementCodebaseUsage[] = [];
  if (!existsSync(root)) return out;
  for (const reqId of readdirSync(root)) {
    const cb = join(root, reqId, "codebase");
    if (!existsSync(cb)) continue;
    try {
      const s = statSync(cb);
      out.push({ reqId, path: cb, size: dirSizeBytes(cb), mtime: s.mtimeMs });
    } catch { /* skip */ }
  }
  return out;
}

/**
 * 应用保留策略清理 sandbox：按 (a) 超过 days (b) 总占用超 max_total_mb 清理。
 * 两条轨：
 *   - 旧轨：任务自有 workspace/（legacy runtime/tasks/ + runs/<id>/workspace，存量任务）
 *     —— 终态任务（isTerminal）才可清
 *   - 新轨（v2 R4）：需求级 codebase/（runtime/requirements/<reqId>/codebase/）
 *     —— **只清终态需求**（isRequirementTerminal；不传回调 = 永不清，fix run 的保障）
 * 返回被清理的标识列表（任务=taskId；codebase 条目带 "codebase:" 前缀）。
 * 仅清代码目录，不动 logs / agent-calls / DB 记录。
 *
 * 可注入 opts.tasksRoot / requirementsRoot 让测试用 tmpdir；生产路径不传走默认。
 */
export function applyRetentionPolicy(
  policy: RetentionPolicy,
  opts?: {
    isTerminal?: (taskId: string) => boolean;
    /** 需求是否终态（done/cancelled/failed）；不传 = 需求级 codebase 一律不清（非终态保护） */
    isRequirementTerminal?: (reqId: string) => boolean;
    now?: number;
    /** 显式指定 legacy tasks 根目录（测试用 tmpdir），默认 AUTOPILOT_HOME/runtime/tasks */
    tasksRoot?: string;
    /** 显式指定 requirements 根目录（测试用 tmpdir）；只传 tasksRoot 时不扫默认新根 */
    requirementsRoot?: string;
  },
): { removed: string[]; reclaimedBytes: number } {
  const now = opts?.now ?? Date.now();
  const injectedRoots = !!opts?.tasksRoot || !!opts?.requirementsRoot;
  const all = scanTaskSandboxes(opts?.tasksRoot, opts?.requirementsRoot)
    .filter((u) => u.exists && u.size > 0);
  // 需求级 codebase 轨：requirementsRoot 注入优先；只注入 tasksRoot 时不扫默认根（同 runs 扫描语义）
  const cbRoot = opts?.requirementsRoot ?? (opts?.tasksRoot ? null : undefined);
  const cbAll = cbRoot === null ? [] : scanRequirementCodebases(cbRoot).filter((u) => u.size > 0);

  const removed: string[] = [];
  let reclaimed = 0;

  const taskRemovable = (u: TaskSandboxUsage) => !opts?.isTerminal || opts.isTerminal(u.taskId);
  // codebase 非终态永不清：回调缺省按"非终态"处理（与任务轨"缺省可删"刻意不同——
  // codebase 是 fix run 的工作现场，宁可漏清不可误删）
  const cbRemovable = (u: RequirementCodebaseUsage) =>
    !!opts?.isRequirementTerminal && opts.isRequirementTerminal(u.reqId);

  const doRemoveTask = (u: TaskSandboxUsage) => {
    const ws = join(u.root, "workspace");
    if (!existsSync(ws)) return;
    // 若是 worktree task，先 git worktree remove --force 让 workspace 干净（spec §3.4：
    // 超过保留期还没提交就是垃圾，直接 force 干掉）。测试场景注入 tmpdir 根时
    // .worktree.json 不存在，removeTaskWorktree 是 no-op，不影响。
    if (!injectedRoots) {
      try { removeTaskWorktree(u.taskId); } catch { /* ignore */ }
    }
    try {
      rmSync(ws, { recursive: true, force: true });
      removed.push(u.taskId);
      reclaimed += u.size;
    } catch { /* ignore */ }
  };

  const doRemoveCodebase = (u: RequirementCodebaseUsage) => {
    if (!existsSync(u.path)) return;
    try {
      rmSync(u.path, { recursive: true, force: true });
      // 清单一并清：目录没了清单就是过期账本
      try { rmSync(join(u.path, "..", ".codebase.json"), { force: true }); } catch { /* ignore */ }
      removed.push(`codebase:${u.reqId}`);
      reclaimed += u.size;
    } catch { /* ignore */ }
  };

  // (a) 按天数清终态
  if (typeof policy.days === "number" && policy.days > 0) {
    const threshold = now - policy.days * 86400 * 1000;
    for (const u of all) {
      if (u.mtime && u.mtime < threshold && taskRemovable(u)) doRemoveTask(u);
    }
    for (const u of cbAll) {
      if (u.mtime && u.mtime < threshold && cbRemovable(u)) doRemoveCodebase(u);
    }
  }

  // (b) 总占用超限时，按 mtime 旧→新再删（两轨合并计算总量）
  if (typeof policy.max_total_mb === "number" && policy.max_total_mb > 0) {
    const maxBytes = policy.max_total_mb * 1024 * 1024;
    type Candidate =
      | { kind: "task"; mtime: number; size: number; u: TaskSandboxUsage }
      | { kind: "codebase"; mtime: number; size: number; u: RequirementCodebaseUsage };
    const remaining: Candidate[] = [
      ...all
        .filter((u) => !removed.includes(u.taskId))
        .map((u): Candidate => ({ kind: "task", mtime: u.mtime, size: u.size, u })),
      ...cbAll
        .filter((u) => !removed.includes(`codebase:${u.reqId}`))
        .map((u): Candidate => ({ kind: "codebase", mtime: u.mtime, size: u.size, u })),
    ];
    let total = remaining.reduce((a, it) => a + it.size, 0);
    if (total > maxBytes) {
      remaining.sort((a, b) => a.mtime - b.mtime);
      for (const c of remaining) {
        if (total <= maxBytes) break;
        if (c.kind === "task" && taskRemovable(c.u)) {
          doRemoveTask(c.u);
          total -= c.size;
        } else if (c.kind === "codebase" && cbRemovable(c.u)) {
          doRemoveCodebase(c.u);
          total -= c.size;
        }
      }
    }
  }

  return { removed, reclaimedBytes: reclaimed };
}

/**
 * 扫所有任务 sandbox 大小 + mtime（双根：legacy runtime/tasks/ + runtime/requirements/<reqId>/runs/）。
 * 可注入根目录让测试用 tmpdir；只传 rootOverride 时不扫默认新根（保持旧测试语义）。
 */
export function scanTaskSandboxes(rootOverride?: string, requirementsRootOverride?: string): TaskSandboxUsage[] {
  const out: TaskSandboxUsage[] = [];

  const scanOne = (taskRoot: string, taskId: string) => {
    const ws = join(taskRoot, "workspace");
    if (!existsSync(ws)) {
      out.push({ taskId, root: taskRoot, size: 0, mtime: 0, exists: false });
      return;
    }
    try {
      const s = statSync(ws);
      out.push({ taskId, root: taskRoot, size: dirSizeBytes(ws), mtime: s.mtimeMs, exists: true });
    } catch {
      out.push({ taskId, root: taskRoot, size: 0, mtime: 0, exists: false });
    }
  };

  // legacy 根：runtime/tasks/<taskId>/
  const legacyRoot = rootOverride ?? tasksRootDir();
  if (existsSync(legacyRoot)) {
    for (const taskId of readdirSync(legacyRoot)) {
      scanOne(join(legacyRoot, taskId), taskId);
    }
  }

  // 新根：runtime/requirements/<reqId>/runs/<taskId>/（v2 R2）
  const reqRoot = requirementsRootOverride ?? (rootOverride ? null : requirementsRootDir());
  if (reqRoot && existsSync(reqRoot)) {
    for (const reqId of readdirSync(reqRoot)) {
      const runsDir = join(reqRoot, reqId, "runs");
      if (!existsSync(runsDir)) continue;
      try {
        for (const taskId of readdirSync(runsDir)) {
          scanOne(join(runsDir, taskId), taskId);
        }
      } catch { /* skip */ }
    }
  }

  return out;
}
