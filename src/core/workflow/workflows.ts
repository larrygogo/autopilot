import { getDb } from "../db";
import { createLogger } from "../logger";
import { stringifyWorkflowDoc, parseWorkflowText } from "./serialize";

const log = createLogger("workflows");

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

export type WorkflowKind = "file" | "derived" | "native" | "template";

export interface WorkflowRow {
  name: string;
  description: string;
  yaml_content: string;
  /** 结构原生 json 真相（kind=native/template）；file/derived 为 null（真相是 yaml_content/磁盘） */
  spec_json: string | null;
  source: "db" | "file";
  kind: WorkflowKind;
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

export interface CreateNativeDbWorkflowOpts {
  name: string;
  description: string;
  /** 结构原生 json（真相）。yaml_content 由它派生投影，spec_json 是唯一真相 */
  spec_json: string;
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
      "INSERT INTO workflows (name, description, yaml_content, source, kind, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', 'file', ?, ?, ?)",
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
    "INSERT INTO workflows (name, description, yaml_content, source, kind, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', 'derived', ?, ?, ?)",
    [opts.name, opts.description, opts.yaml_content, opts.derives_from, ts, ts]
  );
  return getWorkflowFromDb(opts.name) as WorkflowRow;
}

const PHASE_NAME_RE = /^[a-z][a-z0-9_]*$/;
// native/template 是声明式（无任意用户 ts）。这些「函数引用」字段在声明式工作流里无意义且有害：
// 字符串值会幸存到运行时被 truthy 调用抛 TypeError（如 notify_func）。写库时主动 strip。
const STRIP_FUNC_FIELDS = ["setup_func", "notify_func", "hooks"];

/**
 * 校验 + 归一化 native/template 的 spec 对象（写库前收口，**避免畸形 spec 静默幽灵掉出 registry**）。
 *   - phases 必须是非空数组，每个 phase 名合法（PHASE_NAME_RE）、不重复（含 parallel 子阶段）
 *   - 顶层 name/description 归一为行 name/description（行 name = spec.name = yaml.name 恒等）
 *   - strip 声明式无意义的函数引用字段（setup_func/notify_func/hooks）
 * 返回归一化后的纯对象。非法结构在此抛错（挡在写库前，import RPC 映射成 INVALID_PARAM）。
 */
function normalizeSpecDoc(raw: unknown, name: string, description: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("spec 必须是对象");
  const doc = { ...(raw as Record<string, unknown>) };
  const phases = doc["phases"];
  if (!Array.isArray(phases) || phases.length === 0) throw new Error("spec 的 phases 必须是非空数组");
  const seen = new Set<string>();
  for (const p of phases) {
    if (!p || typeof p !== "object") throw new Error("phase 必须是对象");
    const po = p as Record<string, unknown>;
    if (po["parallel"] && typeof po["parallel"] === "object") {
      const par = po["parallel"] as Record<string, unknown>;
      const pn = par["name"];
      if (typeof pn !== "string" || !PHASE_NAME_RE.test(pn)) throw new Error(`parallel 名非法：${String(pn)}`);
      if (seen.has(pn)) throw new Error(`阶段名重复：${pn}`);
      seen.add(pn);
      const subs = par["phases"];
      if (!Array.isArray(subs) || subs.length === 0) throw new Error(`parallel "${pn}" 内 phases 不能为空`);
      for (const s of subs) {
        const sn = (s as Record<string, unknown>)?.["name"];
        if (typeof sn !== "string" || !PHASE_NAME_RE.test(sn)) throw new Error(`阶段名非法：${String(sn)}`);
        if (seen.has(sn)) throw new Error(`阶段名重复：${sn}`);
        seen.add(sn);
      }
    } else {
      const n = po["name"];
      if (typeof n !== "string" || !PHASE_NAME_RE.test(n)) throw new Error(`阶段名非法：${String(n)}`);
      if (seen.has(n)) throw new Error(`阶段名重复：${n}`);
      seen.add(n);
    }
  }
  doc["name"] = name;
  doc["description"] = description;
  for (const f of STRIP_FUNC_FIELDS) delete doc[f];
  return doc;
}

/**
 * 创建「spec_json 真相」的 DB 工作流（native 或 template）。
 * spec_json 是唯一真相；yaml_content 存 spec_json 的 yaml 投影（兼容 getYaml / 编辑器读路径）。
 * native = 用户导入/创建；template = 框架 init 种子（语义区分，组装路径同）。
 */
function insertSpecDbWorkflow(opts: CreateNativeDbWorkflowOpts, kind: "native" | "template"): WorkflowRow {
  if (getWorkflowFromDb(opts.name)) {
    throw new Error(`工作流 "${opts.name}" 已存在`);
  }
  // 校验 + 归一化（非法结构 / 函数字段挡在写库前；行 name = spec.name = yaml.name 恒等）
  const doc = normalizeSpecDoc(JSON.parse(opts.spec_json), opts.name, opts.description);
  const spec_json = stringifyWorkflowDoc(doc, "json");
  const yaml_content = stringifyWorkflowDoc(doc, "yaml");

  const db = getDb();
  const ts = Date.now();
  db.run(
    "INSERT INTO workflows (name, description, yaml_content, spec_json, source, kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'db', ?, ?, ?)",
    [opts.name, opts.description, yaml_content, spec_json, kind, ts, ts]
  );
  return getWorkflowFromDb(opts.name) as WorkflowRow;
}

/** 创建独立 DB 工作流（kind=native：DB 是真相源，无寄生 base）。用户导入/创建走这条。 */
export function createNativeDbWorkflow(opts: CreateNativeDbWorkflowOpts): WorkflowRow {
  return insertSpecDbWorkflow(opts, "native");
}

/** 创建框架内置模板 DB 工作流（kind=template：init 种子，可被模板同步更新）。 */
export function createTemplateDbWorkflow(opts: CreateNativeDbWorkflowOpts): WorkflowRow {
  return insertSpecDbWorkflow(opts, "template");
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
    // native/template 的真相是 spec_json（compose 读它）。编辑器改的是 yaml_content（投影 +
    // 人类编辑面），若不同步 spec_json，编辑会在 reload/compose 时静默丢失。这里校验+归一化+重派生
    // spec_json，保持「spec_json === parse(yaml_content)」不变式（畸形结构在此抛错，不写脏行）。
    // derived/file 的 spec_json 恒 null，不动。
    if (existing.kind === "native" || existing.kind === "template") {
      const desc = opts.description ?? existing.description;
      const doc = normalizeSpecDoc(parseWorkflowText(opts.yaml_content, "yaml"), name, desc);
      // 用归一化后的 doc 覆盖 yaml_content（保证 yaml 投影也归一）+ spec_json
      vals[vals.length - 1] = stringifyWorkflowDoc(doc, "yaml"); // 替换刚 push 的 yaml_content
      fields.push("spec_json = ?");
      vals.push(stringifyWorkflowDoc(doc, "json"));
    }
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
    const existing = getWorkflowFromDb(scan.name);
    // 同名 DB 工作流（native/derived/template）占用此名 → 磁盘同名副本被忽略，**不抛错搞挂整批**。
    // 旧逻辑直接 upsertFileWorkflow 撞名抛错 → discover 株连 fallback 把所有 DB 工作流踢出注册表
    // （高危：workflow sync dev --apply 后 DB 工作流静默蒸发）。DB 工作流优先，文件副本忽略。
    if (existing && existing.source !== "file") {
      log.warn(
        "工作流 \"%s\" 已是 DB 工作流（source=%s），磁盘同名副本被忽略；要更新 DB 工作流请用 autopilot workflow import",
        scan.name, existing.source,
      );
      continue;
    }
    seen.add(scan.name);
    if (!existing) {
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
