import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import { emit } from "./event-bus";
import {
  writeManifest,
  updateManifest,
  MANIFEST_VERSION,
  type TaskManifest,
  type WorkflowSnapshot,
} from "./manifest";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  workflow: string;
  status: string;
  failure_count: number;
  channel: string;
  notify_target: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  parent_task_id: string | null;
  parallel_index: number | null;
  parallel_group: string | null;
  /** 关联需求 id（reqId），可空兼容历史无关联任务。migration 019 加入。 */
  requirement_id: string | null;
  /** run 种类（v2 R2，migration 044）：execution=主执行；fix=修复轮（R3 接入） */
  kind: string;
  /** 需求内 run 序号（v2 R2，migration 044）：同一需求第几次执行，供排序/展示 */
  seq: number;
  [key: string]: unknown;
}

export interface TaskLog {
  id: number;
  task_id: string;
  from_status: string | null;
  to_status: string;
  trigger_name: string | null;
  note: string | null;
  created_at: string;
}

// ──────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────

const SCHEMA = [
  // 基础 schema（裸表）—— 后续字段演进全部走 migrations/NNN-*.ts，
  // 这里不加新列，避免老 DB（IF NOT EXISTS 跳过建表）+ 索引引用未存在列时崩。
  "CREATE TABLE IF NOT EXISTS tasks (",
  "    id TEXT PRIMARY KEY,",
  "    title TEXT NOT NULL,",
  "    workflow TEXT NOT NULL,",
  "    status TEXT NOT NULL,",
  "    failure_count INTEGER DEFAULT 0,",
  "    channel TEXT DEFAULT 'log',",
  "    notify_target TEXT,",
  "    extra TEXT DEFAULT '{}',",
  "    created_at TEXT NOT NULL,",
  "    updated_at TEXT NOT NULL,",
  "    started_at TEXT,",
  "    parent_task_id TEXT DEFAULT NULL,",
  "    parallel_index INTEGER DEFAULT NULL,",
  "    parallel_group TEXT DEFAULT NULL",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS task_logs (",
  "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "    task_id TEXT NOT NULL,",
  "    from_status TEXT,",
  "    to_status TEXT NOT NULL,",
  "    trigger_name TEXT,",
  "    note TEXT,",
  "    created_at TEXT NOT NULL,",
  "    FOREIGN KEY (task_id) REFERENCES tasks(id)",
  ");",
  "",
  "CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks (workflow);",
  "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);",
  // idx_tasks_requirement_id 在 migration 019 中创建（列添加后立刻建索引）
  "CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs (task_id);",
].join("\n");

// tasks 表中实际存在的列字段（用于区分列字段和 extra JSON 字段）
export const TABLE_COLUMNS = new Set([
  "id",
  "title",
  "workflow",
  "status",
  "failure_count",
  "channel",
  "notify_target",
  "extra",
  "created_at",
  "updated_at",
  "started_at",
  "parent_task_id",
  "parallel_index",
  "parallel_group",
  "requirement_id",
  "kind",
  "seq",
]);

// 受保护的列字段，不允许通过 extraUpdates/updateTask 修改
export const PROTECTED_COLUMNS = new Set([
  "id",
  "workflow",
  "created_at",
]);

// ──────────────────────────────────────────────
// 数据库单例
// ──────────────────────────────────────────────

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    const runtimeDir = join(AUTOPILOT_HOME, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const dbPath = join(runtimeDir, "workflow.db");
    _db = new Database(dbPath);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** 仅供测试使用：注入外部 Database 实例 */
export function _setDbForTest(db: Database | null): void {
  _db = db;
}

export function initDb(): void {
  const db = getDb();
  db.run("PRAGMA journal_mode=WAL");
  // 写锁竞争时自旋重试至多 5s 而非立即抛 SQLITE_BUSY（CONC-07）：daemon 与 run-phase 子进程
  // 并发写同库的窄窗口下兜底。per-connection 设置，initDb 是唯一规范初始化入口故两端都覆盖。
  db.run("PRAGMA busy_timeout=5000");
  db.run("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA);
}

export function now(): string {
  return new Date().toISOString();
}

/**
 * 原子地「生成 id → INSERT」：撞 UNIQUE / PRIMARY KEY 时自动换号重试。
 *
 * 消除 `const id = nextXxxId(); insert(id)` 两步之间的并发撞号窗口（architect 审查 H3：
 * SELECT MAX+1 与 INSERT 非原子，daemon 与 run-phase 子进程并发写同库时两侧可能拿到同号）。
 * id 是 `xxx-NNN` 格式字符串（非 autoincrement），故用「乐观插入 + 撞号重试」而非序列表。
 * 仅对约束冲突重试；其它错误立即抛。
 */
export function insertWithFreshId<T>(genId: () => string, insert: (id: string) => T, retries = 8): T {
  for (let attempt = 0; ; attempt++) {
    const id = genId();
    try {
      return insert(id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < retries && /UNIQUE constraint|PRIMARY KEY|constraint failed/i.test(msg)) continue;
      throw e;
    }
  }
}

// ──────────────────────────────────────────────
// 内部辅助
// ──────────────────────────────────────────────

interface RawRow {
  extra?: string | null;
  [key: string]: unknown;
}

function rowToTask(row: RawRow): Task {
  const { extra, ...rest } = row;
  let extraObj: Record<string, unknown> = {};
  try {
    extraObj = extra ? (JSON.parse(extra as string) as Record<string, unknown>) : {};
  } catch {
    extraObj = {};
  }
  // extra 中的 key 不覆盖列字段
  const merged: Record<string, unknown> = { ...extraObj };
  for (const [k, v] of Object.entries(rest)) {
    merged[k] = v;
  }
  return merged as unknown as Task;
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export function getTask(taskId: string): Task | null {
  const db = getDb();
  const row = db
    .query<RawRow, [string]>("SELECT * FROM tasks WHERE id = ?")
    .get(taskId);
  return row ? rowToTask(row) : null;
}

export interface CreateTaskOpts {
  id: string;
  title: string;
  workflow: string;
  initialStatus: string;
  channel?: string;
  notifyTarget?: string | null;
  extra?: Record<string, unknown>;
  /** 关联需求 id；可空（命令行手动创建 task 时无 requirement） */
  requirementId?: string | null;
  /** run 种类（缺省 execution）。v2 R2：task = 需求的执行历史项 */
  kind?: string;
  /** 需求内 run 序号（缺省 1）。重跑=新 run 时由 task-factory 计算递增 */
  seq?: number;
  /**
   * 工作流定义快照。若提供则同步写入 task-manifest.json 作为权威源（gsd-style）。
   * 省略时只写 DB（测试 / 老路径兼容）。
   */
  workflowSnapshot?: WorkflowSnapshot;
}

export function createTask(opts: CreateTaskOpts): void {
  const db = getDb();
  const ts = now();
  db.run(
    "INSERT INTO tasks" +
    " (id, title, workflow, status, channel, notify_target, extra, created_at, updated_at, requirement_id, kind, seq)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      opts.id,
      opts.title,
      opts.workflow,
      opts.initialStatus,
      opts.channel ?? "log",
      opts.notifyTarget ?? null,
      JSON.stringify(opts.extra ?? {}),
      ts,
      ts,
      opts.requirementId ?? null,
      opts.kind ?? "execution",
      opts.seq ?? 1,
    ]
  );
  if (opts.workflowSnapshot) {
    const manifest: TaskManifest = {
      version: MANIFEST_VERSION,
      taskId: opts.id,
      title: opts.title,
      workflow: opts.workflow,
      workflow_snapshot: opts.workflowSnapshot,
      status: opts.initialStatus,
      failure_count: 0,
      channel: opts.channel ?? "log",
      notify_target: opts.notifyTarget ?? null,
      created_at: ts,
      updated_at: ts,
      started_at: null,
      parent_task_id: null,
      parallel_index: null,
      parallel_group: null,
      extra: opts.extra ?? {},
      transitions: [],
    };
    writeManifest(manifest);
  }
  const created = getTask(opts.id);
  if (created) emit({ type: "task:created", payload: { task: created } });
}

export function updateTask(
  taskId: string,
  fields: Record<string, unknown>
): void {
  const db = getDb();

  const colUpdates: string[] = [];
  const colValues: unknown[] = [];
  const extraUpdates: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (key === "extra" || PROTECTED_COLUMNS.has(key)) continue;
    if (TABLE_COLUMNS.has(key)) {
      colUpdates.push(key + " = ?");
      colValues.push(value);
    } else {
      extraUpdates[key] = value;
    }
  }

  const hasExtraUpdates = Object.keys(extraUpdates).length > 0;

  if (!hasExtraUpdates && colUpdates.length === 0) return;

  if (hasExtraUpdates) {
    // 使用事务保证 extra 字段合并的原子性
    db.transaction(() => {
      const row = db
        .query<{ extra: string | null }, [string]>(
          "SELECT extra FROM tasks WHERE id = ?"
        )
        .get(taskId);
      let currentExtra: Record<string, unknown> = {};
      try {
        currentExtra = row?.extra ? JSON.parse(row.extra) : {};
      } catch {
        currentExtra = {};
      }
      const mergedExtra = { ...currentExtra, ...extraUpdates };

      colUpdates.push("extra = ?");
      colValues.push(JSON.stringify(mergedExtra));
      colUpdates.push("updated_at = ?");
      colValues.push(now());
      colValues.push(taskId);

      db.run(
        "UPDATE tasks SET " + colUpdates.join(", ") + " WHERE id = ?",
        colValues as Parameters<typeof db.run>[1]
      );
    })();
  } else {
    colUpdates.push("updated_at = ?");
    colValues.push(now());
    colValues.push(taskId);

    db.run(
      "UPDATE tasks SET " + colUpdates.join(", ") + " WHERE id = ?",
      colValues as Parameters<typeof db.run>[1]
    );
  }

  const updated = getTask(taskId);
  if (updated) {
    syncManifestFromTask(updated);
    emit({ type: "task:updated", payload: { task: updated, fields: Object.keys(fields) } });
  }
}

/**
 * 心跳：仅刷新 task.updated_at，让 watcher 知道长跑阶段还活着。
 *
 * 设计取舍：
 * - 不走 updateTask（它在无字段时 early-return）
 * - 不同步 manifest / 不发事件：心跳每 2 分钟一次，没必要产生推送噪音
 * - 集中到 db.ts 保持 single-writer 不变式（写 tasks 表的入口唯一）
 */
export function touchTaskHeartbeat(taskId: string): void {
  getDb().run("UPDATE tasks SET updated_at = ? WHERE id = ?", [now(), taskId]);
}

/**
 * 原子追加一条 pending_prompt 到 task.extra.pending_prompts 数组（spec §3.8 + §8 风险表）。
 *
 * 走单事务 read-modify-write 整个数组，避免短间隔多次 send_prompt 在 updateTask 合并时
 * 后写覆盖前写。所有 send_prompt 写入必须走此函数，不要直接 updateTask({pending_prompts: ...})。
 */
export interface PendingPromptItem {
  prompt: string;
  source: "user" | "schedule" | "github";
  queued_at: number;
}

export function appendPendingPrompt(taskId: string, item: PendingPromptItem): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .query<{ extra: string | null }, [string]>("SELECT extra FROM tasks WHERE id = ?")
      .get(taskId);
    if (!row) throw new Error(`appendPendingPrompt: task not found: ${taskId}`);
    let extra: Record<string, unknown> = {};
    try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch { extra = {}; }
    const existing = Array.isArray(extra.pending_prompts) ? extra.pending_prompts : [];
    extra.pending_prompts = [...existing, item];
    db.run(
      "UPDATE tasks SET extra = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(extra), now(), taskId],
    );
  })();

  const updated = getTask(taskId);
  if (updated) {
    syncManifestFromTask(updated);
    emit({ type: "task:updated", payload: { task: updated, fields: ["pending_prompts"] } });
  }
}

/**
 * 把 Task（含合并后的 extra）同步到 task-manifest.json。
 * manifest 不存在时 best-effort 跳过（老任务或 snapshot 未提供的 createTask 路径）。
 */
function syncManifestFromTask(task: Task): void {
  const patch = {
    title: task.title,
    status: task.status,
    failure_count: task.failure_count,
    channel: task.channel,
    notify_target: task.notify_target,
    updated_at: task.updated_at,
    started_at: task.started_at,
    parent_task_id: task.parent_task_id,
    parallel_index: task.parallel_index,
    parallel_group: task.parallel_group,
    extra: extractExtra(task),
  };
  updateManifest(task.id, patch);
}

/** 从 Task 对象里抽取 extra 字段（非列字段） */
function extractExtra(task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(task)) {
    if (TABLE_COLUMNS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface ListTasksFilters {
  status?: string;
  workflow?: string;
  limit?: number;
}

export function listTasks(filters: ListTasksFilters = {}): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: any[] = [];

  if (filters.status !== undefined) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters.workflow !== undefined) {
    conditions.push("workflow = ?");
    values.push(filters.workflow);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  if (filters.limit !== undefined) {
    values.push(filters.limit);
  }
  const limitClause = filters.limit !== undefined ? "LIMIT ?" : "";

  const rows = db
    .query<RawRow, any[]>(
      "SELECT * FROM tasks " + where + " ORDER BY created_at DESC " + limitClause
    )
    .all(...values);

  return rows.map(rowToTask);
}

export function getTaskLogs(
  taskId: string,
  limit = 100
): Record<string, unknown>[] {
  const db = getDb();
  return db
    .query<Record<string, unknown>, [string, number]>(
      "SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(taskId, limit);
}

// ──────────────────────────────────────────────
// 子任务（并行支持）
// ──────────────────────────────────────────────

export interface CreateSubTaskOpts {
  parentTaskId: string;
  subTaskId: string;
  phaseName: string;
  parallelGroup: string;
  parallelIndex: number;
  initialStatus?: string;
}

export function createSubTask(opts: CreateSubTaskOpts): void {
  const db = getDb();
  const parent = getTask(opts.parentTaskId);
  if (!parent) throw new Error("父任务不存在：" + opts.parentTaskId);

  // 继承父任务的 extra 字段（只取非列字段部分）
  const parentExtra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (!TABLE_COLUMNS.has(key) && key !== "extra") {
      parentExtra[key] = value;
    }
  }

  const ts = now();
  db.run(
    "INSERT OR IGNORE INTO tasks" +
    " (id, title, workflow, status, channel, notify_target, extra," +
    "  created_at, updated_at, parent_task_id, parallel_index, parallel_group, requirement_id)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      opts.subTaskId,
      opts.phaseName,
      parent.workflow,
      opts.initialStatus ?? "pending",
      parent.channel,
      parent.notify_target ?? null,
      JSON.stringify(parentExtra),
      ts,
      ts,
      opts.parentTaskId,
      opts.parallelIndex,
      opts.parallelGroup,
      // 子任务不是独立的"工作"，继承父任务的 requirement_id（每个任务必有需求）
      parent.requirement_id ?? null,
    ]
  );
}

export function getSubTasks(parentTaskId: string): Task[] {
  const db = getDb();
  const rows = db
    .query<RawRow, [string]>(
      "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY parallel_index ASC"
    )
    .all(parentTaskId);
  return rows.map(rowToTask);
}

/**
 * 按 requirement id 列表查根任务（parent_task_id IS NULL）。
 * 供项目级联删除收集需要清理的任务树根（子任务由调用方经 getSubTasks 展开）。
 */
export function listRootTasksByRequirementIds(requirementIds: string[]): Task[] {
  if (requirementIds.length === 0) return [];
  const db = getDb();
  const placeholders = requirementIds.map(() => "?").join(",");
  const rows = db
    .query<RawRow, string[]>(
      "SELECT * FROM tasks WHERE requirement_id IN (" +
        placeholders +
        ") AND parent_task_id IS NULL ORDER BY created_at ASC"
    )
    .all(...requirementIds);
  return rows.map(rowToTask);
}

/**
 * 按单个 requirement id 查其全部根 run（v2 R6）：parent_task_id IS NULL（排除并行块子任务），
 * 按 seq 升序、再 created_at 升序排（seq 缺省/相同的历史数据用创建时间兜底稳定排序）。
 * 供需求页执行记录区按 run 切换展示（一件工作的全部执行历史，含重跑 / fix 轮）。
 */
export function listTasksByRequirement(requirementId: string): Task[] {
  const db = getDb();
  const rows = db
    .query<RawRow, [string]>(
      "SELECT * FROM tasks WHERE requirement_id = ? AND parent_task_id IS NULL " +
        "ORDER BY seq ASC, created_at ASC"
    )
    .all(requirementId);
  return rows.map(rowToTask);
}

/**
 * 计算某需求下一个 run 的序号（v2 R2）：现有根任务（run）的最大 seq + 1。
 * 用 MAX 而非 COUNT：历史 run 被删除后 COUNT 会回退撞号，MAX 保证单调递增。
 * 并行块子任务（parent_task_id 非空）不是独立 run，不参与编号。
 */
export function nextRunSeqForRequirement(requirementId: string): number {
  const row = getDb()
    .query<{ s: number | null }, [string]>(
      "SELECT MAX(seq) AS s FROM tasks WHERE requirement_id = ? AND parent_task_id IS NULL"
    )
    .get(requirementId);
  return (row?.s ?? 0) + 1;
}

/**
 * 原子级联删除一组 task：先删 task_logs / task_phase_events，再删 tasks 本身。
 * 仅做 DB 层删除，不动文件/锁/manifest；不 emit 事件。
 * 由 task-delete.ts 统一协调，高层负责预校验与外部副作用清理。
 */
export function deleteTaskRecords(taskIds: string[]): void {
  if (taskIds.length === 0) return;
  const db = getDb();
  const placeholders = taskIds.map(() => "?").join(",");
  db.transaction(() => {
    db.run("DELETE FROM task_logs WHERE task_id IN (" + placeholders + ")", taskIds);
    db.run("DELETE FROM task_phase_events WHERE task_id IN (" + placeholders + ")", taskIds);
    db.run("DELETE FROM tasks WHERE id IN (" + placeholders + ")", taskIds);
  })();
}

// ──────────────────────────────────────────────
// kv 简单键值存储（迁移 017）
// ──────────────────────────────────────────────

/** 写入 kv 键值；存在则覆盖并更新 updated_at。 */
export function setKv(key: string, value: string): void {
  getDb().run(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    [key, value]
  );
}

/** 读取 kv 值；不存在返回 null。 */
export function getKv(key: string): string | null {
  const row = getDb().query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key);
  return row?.value ?? null;
}

// ──────────────────────────────────────────────
// task_phase_events（迁移 018）
// ──────────────────────────────────────────────

export interface TaskPhaseEvent {
  id: number;
  task_id: string;
  phase: string;
  /** aborted = daemon 重启 / watcher 恢复 / 取消时被打断的轮次（closeOpenPhaseEvents 写入） */
  status: "running" | "done" | "awaiting" | "failed" | "aborted";
  started_at: number;
  ended_at: number | null;
}

/** 在 phase 开始时插入一条 running event。返回 event id 用于后续 end。 */
export function startTaskPhase(taskId: string, phase: string): number {
  const db = getDb();
  const result = db.run(
    "INSERT INTO task_phase_events (task_id, phase, status, started_at) VALUES (?, ?, 'running', ?)",
    [taskId, phase, Date.now()],
  );
  return Number(result.lastInsertRowid);
}

/** 标记 event 结束。无对应 event id 时静默忽略（防御）。 */
export function endTaskPhase(eventId: number, status: "done" | "awaiting" | "failed"): void {
  const db = getDb();
  db.run(
    "UPDATE task_phase_events SET status = ?, ended_at = ? WHERE id = ?",
    [status, Date.now(), eventId],
  );
}

/**
 * 关闭某 task 所有未结束（ended_at IS NULL）的 phase event，标记为 aborted。
 * 用于 cancel / 重置重跑前清理"进行中"的 event，避免留下永远 running 的僵尸记录
 * （会让阶段进度 UI 把耗时累加到 now、状态恒显示"进行中"）。
 */
export function closeOpenPhaseEvents(taskId: string): void {
  const db = getDb();
  // ended_at 写打断时刻（而非归零到 started_at）：被打断的轮次跑了多久是真实信息，
  // 归零会让执行时间线把跑了 37 分钟的轮显示成 0s（dogfood 实测困惑点）
  db.run(
    "UPDATE task_phase_events SET status = 'aborted', ended_at = ? WHERE task_id = ? AND ended_at IS NULL",
    [Date.now(), taskId],
  );
}

/** 列出某 task 全部 phase event，按 started_at 升序。 */
export function listTaskPhaseEvents(taskId: string): TaskPhaseEvent[] {
  const db = getDb();
  return db
    .query<TaskPhaseEvent, [string]>(
      "SELECT id, task_id, phase, status, started_at, ended_at FROM task_phase_events WHERE task_id = ? ORDER BY started_at ASC, id ASC"
    )
    .all(taskId);
}

/** getWorkflowPhaseStats 取样上限：只用最近 N 条 done 事件算 P50（防 phase_events 无限增长拖慢）。 */
const PHASE_STATS_SAMPLE_LIMIT = 2000;

/**
 * 同工作流历史 phase 耗时统计 — 用作"还要多久"参考值。
 * 只计入 status='done' 且 ended_at 非空的事件；每 phase 应用层算 P50（中位数）。
 * 取**最近 PHASE_STATS_SAMPLE_LIMIT 条**（ended_at DESC）：phase_events 是 append-only 无清理，
 * 不封顶则随历史线性变慢（architect 审查 H4 温水隐患）；近期窗口同时让 ETA 反映当前性能更准。
 */
export function getWorkflowPhaseStats(workflow: string): Record<string, { count: number; p50_ms: number }> {
  const db = getDb();
  const rows = db
    .query<{ phase: string; dur: number }, [string, number]>(
      `SELECT e.phase AS phase, (e.ended_at - e.started_at) AS dur
       FROM task_phase_events e
       JOIN tasks t ON t.id = e.task_id
       WHERE t.workflow = ?
         AND e.status = 'done'
         AND e.ended_at IS NOT NULL
         AND e.ended_at > e.started_at
       ORDER BY e.ended_at DESC
       LIMIT ?`
    )
    .all(workflow, PHASE_STATS_SAMPLE_LIMIT);

  const byPhase = new Map<string, number[]>();
  for (const r of rows) {
    let arr = byPhase.get(r.phase);
    if (!arr) {
      arr = [];
      byPhase.set(r.phase, arr);
    }
    arr.push(r.dur);
  }

  const result: Record<string, { count: number; p50_ms: number }> = {};
  for (const [phase, durs] of byPhase) {
    durs.sort((a, b) => a - b);
    const n = durs.length;
    const mid = Math.floor(n / 2);
    const p50 = n % 2 === 0 ? (durs[mid - 1]! + durs[mid]!) / 2 : durs[mid]!;
    result[phase] = { count: n, p50_ms: Math.round(p50) };
  }
  return result;
}
