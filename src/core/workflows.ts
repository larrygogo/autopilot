import { getDb } from "./db";

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

export interface WorkflowRow {
  name: string;
  description: string;
  yaml_content: string;
  source: "db" | "file";
  derives_from: string | null;
  file_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertFileWorkflowOpts {
  name: string;
  description: string;
  yaml_content: string;
  file_path: string;
}

export interface CreateDbWorkflowOpts {
  name: string;
  description: string;
  derives_from: string;
  yaml_content: string;
}

export interface UpdateDbWorkflowOpts {
  description?: string;
  yaml_content?: string;
}

// ──────────────────────────────────────────────
// 查询
// ──────────────────────────────────────────────

export function listWorkflowsInDb(): WorkflowRow[] {
  const db = getDb();
  return db
    .query<WorkflowRow, []>(
      "SELECT * FROM workflows ORDER BY name ASC"
    )
    .all();
}

export function getWorkflowFromDb(name: string): WorkflowRow | null {
  const db = getDb();
  const row = db
    .query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE name = ?")
    .get(name);
  return row ?? null;
}

// ──────────────────────────────────────────────
// 文件工作流：启动时同步
// ──────────────────────────────────────────────

/**
 * 把文件工作流写入 / 更新到 DB（source=file 镜像）。
 * 已存在时 yaml_content / description / updated_at 更新；created_at 保留。
 * 若 DB 中存在同名 source=db 行 → 抛错（同名冲突，spec §4.3）。
 */
export function upsertFileWorkflow(opts: UpsertFileWorkflowOpts): WorkflowRow {
  const db = getDb();
  const ts = Date.now();
  const existing = getWorkflowFromDb(opts.name);
  if (existing && existing.source !== "file") {
    throw new Error(
      `workflow "${opts.name}" 在 DB 中已存在但 source=${existing.source}，与文件冲突；请先删除 DB 工作流或重命名文件目录`
    );
  }
  if (existing) {
    db.run(
      "UPDATE workflows SET description = ?, yaml_content = ?, file_path = ?, updated_at = ? WHERE name = ?",
      [opts.description, opts.yaml_content, opts.file_path, ts, opts.name]
    );
  } else {
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?)",
      [opts.name, opts.description, opts.yaml_content, opts.file_path, ts, ts]
    );
  }
  return getWorkflowFromDb(opts.name) as WorkflowRow;
}

/**
 * 同步阶段结束时调用：删除 DB 中存在但本次 file 扫描里已没有的 file 工作流。
 * （用户手动删除了 ~/.autopilot/workflows/<name>/ 目录的情况）
 */
export function deleteOrphanFileWorkflows(seenNames: Set<string>): string[] {
  const db = getDb();
  const removed: string[] = [];
  const all = db
    .query<{ name: string }, []>(
      "SELECT name FROM workflows WHERE source = 'file'"
    )
    .all();
  for (const { name } of all) {
    if (!seenNames.has(name)) {
      db.run("DELETE FROM workflows WHERE name = ? AND source = 'file'", [name]);
      removed.push(name);
    }
  }
  return removed;
}

// ──────────────────────────────────────────────
// DB 工作流：CRUD
// ──────────────────────────────────────────────

export function createDbWorkflow(opts: CreateDbWorkflowOpts): WorkflowRow {
  const base = getWorkflowFromDb(opts.derives_from);
  if (!base) {
    throw new Error(`derives_from "${opts.derives_from}" 不存在`);
  }
  if (base.source !== "file") {
    throw new Error(
      `derives_from "${opts.derives_from}" 是 source=${base.source}，DB 工作流必须派生自 file 工作流（不支持嵌套派生）`
    );
  }
  if (getWorkflowFromDb(opts.name)) {
    throw new Error(`工作流 "${opts.name}" 已存在`);
  }

  const db = getDb();
  const ts = Date.now();
  db.run(
    "INSERT INTO workflows (name, description, yaml_content, source, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?, ?)",
    [opts.name, opts.description, opts.yaml_content, opts.derives_from, ts, ts]
  );
  return getWorkflowFromDb(opts.name) as WorkflowRow;
}

export function updateDbWorkflow(
  name: string,
  opts: UpdateDbWorkflowOpts
): WorkflowRow | null {
  const existing = getWorkflowFromDb(name);
  if (!existing) return null;
  if (existing.source !== "db") {
    throw new Error(`工作流 "${name}" 是 file 来源、只读；请改源文件后 daemon reload`);
  }

  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number)[] = [];
  if (opts.description !== undefined) {
    fields.push("description = ?");
    vals.push(opts.description);
  }
  if (opts.yaml_content !== undefined) {
    fields.push("yaml_content = ?");
    vals.push(opts.yaml_content);
  }
  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(name);
  db.run(`UPDATE workflows SET ${fields.join(", ")} WHERE name = ?`, vals);
  return getWorkflowFromDb(name);
}

export function deleteDbWorkflow(name: string): void {
  const existing = getWorkflowFromDb(name);
  if (!existing) return;
  if (existing.source !== "db") {
    throw new Error(`工作流 "${name}" 是 file 来源、只读；删除请操作源文件目录`);
  }
  const db = getDb();
  db.run("DELETE FROM workflows WHERE name = ? AND source = 'db'", [name]);
}

// ──────────────────────────────────────────────
// 整体同步：文件扫描 → DB
// ──────────────────────────────────────────────

export interface FileWorkflowScan {
  name: string;
  description: string;
  yaml_content: string;
  file_path: string;
}

export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * 把一次文件扫描结果同步到 DB。
 *
 * 行为：
 *   - 文件里有，DB 里没 → INSERT，记入 added
 *   - 文件里有，DB 里也有 → 比较 description / yaml_content / file_path，
 *     有任一不同则 UPDATE 并记入 updated
 *   - DB 中 source=file 但本次扫描没看到 → DELETE，记入 removed（孤儿清理）
 *   - DB 中 source=db 的行不受影响
 */
export function syncFileWorkflowsToDb(scans: FileWorkflowScan[]): SyncResult {
  const added: string[] = [];
  const updated: string[] = [];

  const seen = new Set<string>();
  for (const scan of scans) {
    seen.add(scan.name);
    const existing = getWorkflowFromDb(scan.name);
    if (!existing || existing.source !== "file") {
      upsertFileWorkflow(scan);
      added.push(scan.name);
      continue;
    }
    const changed =
      existing.description !== scan.description ||
      existing.yaml_content !== scan.yaml_content ||
      existing.file_path !== scan.file_path;
    if (changed) {
      upsertFileWorkflow(scan);
      updated.push(scan.name);
    }
  }

  const removed = deleteOrphanFileWorkflows(seen);
  return { added: added.sort(), updated: updated.sort(), removed: removed.sort() };
}
