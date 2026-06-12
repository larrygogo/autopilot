import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { getDb, getTask } from "./db";
import { getRequirementDir } from "./codebase";
import { log } from "./logger";

// ──────────────────────────────────────────────
// 需求交付物（requirement_deliveries，迁移 046）—— 交付物抽象 P0 产出侧（v2 R5）
//
// 物理落点：runtime/requirements/<reqId>/deliveries/round-<N>/
//   - 交付物生命周期属于需求（这件工作），不属于任务（某次执行尝试）：
//     PR 模型里交付物在 GitHub（沙盒外），artifact 对称放需求目录
//   - done 清理只清 codebase/（deleteRequirementCodebase），deliveries 是轻物料不进 retention，
//     随需求删除（deleteRequirementRuntimeDir 整树删）
// 每验收轮一行（驳回重交 = round+1），UNIQUE(requirement_id, round)。
// 本模块是 requirement_deliveries 表的唯一写入者（single-writer 白名单成员）。
// 纯数据管道（CRUD + promote 文件搬运），不含 'pr'/'artifacts' 等产出形态语义（在 daemon）。
// ──────────────────────────────────────────────

export interface RequirementDelivery {
  id: string;
  requirement_id: string;
  task_id: string | null;
  round: number;
  /** 相对需求运行时目录的落点（deliveries/round-<N>） */
  path: string;
  summary: string | null;
  created_at: number;
}

/** 需求交付物根目录 runtime/requirements/<reqId>/deliveries/。 */
export function getRequirementDeliveriesRoot(reqId: string): string {
  return join(getRequirementDir(reqId), "deliveries");
}

/** 某验收轮的交付物目录（不保证存在）。 */
export function getDeliveryRoundDir(reqId: string, round: number): string {
  if (!Number.isInteger(round) || round < 1) throw new Error(`非法 round：${round}`);
  return join(getRequirementDeliveriesRoot(reqId), `round-${round}`);
}

/** 生成下一个 delivery id，格式 "dlv-NNN"（与 req-NNN 同款扫描法）。 */
export function nextDeliveryId(): string {
  const rows = getDb()
    .query<{ id: string }, []>(
      "SELECT id FROM requirement_deliveries WHERE id LIKE 'dlv-%' ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "dlv-001";
  const n = parseInt(rows[0].id.replace("dlv-", ""), 10) + 1;
  return `dlv-${String(n).padStart(3, "0")}`;
}

/** 某需求的交付记录（按 round 升序）。表不存在（旧库/纯表夹具）→ []。 */
export function listDeliveries(reqId: string): RequirementDelivery[] {
  try {
    return getDb()
      .query<RequirementDelivery, [string]>(
        "SELECT * FROM requirement_deliveries WHERE requirement_id = ? ORDER BY round ASC",
      )
      .all(reqId);
  } catch {
    return [];
  }
}

/** 需求是否有交付记录（bridge delivered 判定 / poller 静默 skip 用）。 */
export function hasDeliveries(reqId: string): boolean {
  return listDeliveries(reqId).length > 0;
}

/** 当前最大验收轮（无记录 = 0）。 */
export function maxDeliveryRound(reqId: string): number {
  const rows = listDeliveries(reqId);
  return rows.length > 0 ? rows[rows.length - 1].round : 0;
}

/** 删除需求的全部交付记录（需求删除级联用；文件随 deleteRequirementRuntimeDir 整树删）。 */
export function deleteDeliveriesForRequirement(reqId: string): void {
  try {
    getDb().run("DELETE FROM requirement_deliveries WHERE requirement_id = ?", [reqId]);
  } catch {
    // 表不存在（迁移未跑的旧库/测试纯表夹具）：no-op
  }
}

/**
 * 交付物 promote：把任务沙盒里的产物目录搬到需求级持久目录并落表一行。
 *
 * - round = 现有 max+1（驳回重交递增，对应 PR 模型的新 commit）
 * - promote 前 rmSync 同 round 目标目录（幂等：上次崩在「拷完没落表」时重跑不残留半套）
 * - promote 后任务沙盒清理 / retention / 重跑都不再威胁交付物
 *
 * @param taskId  产出本轮交付的 run（task）
 * @param fromDir 沙盒内产物目录绝对路径（不存在/为空 → 抛错，防 agent 未按约定产出时静默空交付）
 * @param summary 本轮交付摘要（agent 总结），落表供验收 UI 展示
 */
export function deliverArtifacts(taskId: string, fromDir: string, summary?: string): RequirementDelivery {
  const task = getTask(taskId);
  if (!task) throw new Error(`deliverArtifacts: 任务不存在：${taskId}`);
  const reqId = task.requirement_id;
  if (!reqId) throw new Error(`deliverArtifacts: 任务 ${taskId} 缺少 requirement_id`);
  if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) {
    throw new Error(`deliverArtifacts: 产物目录不存在：${fromDir}`);
  }
  if (readdirSync(fromDir).length === 0) {
    throw new Error(`deliverArtifacts: 产物目录为空：${fromDir}`);
  }

  const round = maxDeliveryRound(reqId) + 1;
  const dest = getDeliveryRoundDir(reqId, round);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(fromDir, dest, { recursive: true });

  const row: RequirementDelivery = {
    id: nextDeliveryId(),
    requirement_id: reqId,
    task_id: taskId,
    round,
    path: `deliveries/round-${round}`,
    summary: summary?.trim() ? summary.trim() : null,
    created_at: Date.now(),
  };
  getDb().run(
    "INSERT INTO requirement_deliveries (id, requirement_id, task_id, round, path, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [row.id, row.requirement_id, row.task_id, row.round, row.path, row.summary, row.created_at],
  );
  log.info("交付物已 promote 到需求目录 [req=%s task=%s round=%s files→%s]", reqId, taskId, round, dest);
  return row;
}

// ──────────────────────────────────────────────
// 验收浏览（文件列表 + 下载路径解析；只列不渲染——范围控制）
// ──────────────────────────────────────────────

export interface DeliveryFileEntry {
  /** 相对该 round 目录的路径（/ 分隔） */
  path: string;
  size: number;
  mtime: number;
}

/** 递归列某验收轮的全部文件（扁平列表，按路径字典序）。目录不存在 → []。 */
export function listDeliveryFiles(reqId: string, round: number): DeliveryFileEntry[] {
  const root = getDeliveryRoundDir(reqId, round);
  if (!existsSync(root)) return [];
  const out: DeliveryFileEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      try {
        const s = statSync(full);
        if (s.isDirectory()) walk(full, rel);
        else if (s.isFile()) out.push({ path: rel, size: s.size, mtime: s.mtimeMs });
      } catch { /* 忽略不可访问项 */ }
    }
  };
  walk(root, "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * 把用户传入的相对路径安全解析到某验收轮目录下的绝对路径（下载通道用）。
 * 防越界：解析后必须仍位于 round 目录下。非法返回 null。
 */
export function resolveDeliveryFilePath(reqId: string, round: number, relPath: string): string | null {
  if (relPath.includes("\0")) return null;
  const root = resolve(getDeliveryRoundDir(reqId, round));
  const trimmed = relPath.replace(/^[/\\]+/, "");
  const candidate = resolve(root, trimmed || ".");
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}
