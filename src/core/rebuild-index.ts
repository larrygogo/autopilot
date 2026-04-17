import { getDb, now, listTasks, getTask, TABLE_COLUMNS } from "./db";
import {
  readManifest,
  writeManifest,
  listManifestTaskIds,
  snapshotWorkflow,
  MANIFEST_VERSION,
  type TaskManifest,
  type WorkflowSnapshot,
  type TransitionRecord,
} from "./manifest";
import { getWorkflow } from "./registry";
import { log } from "./logger";

// ──────────────────────────────────────────────
// 索引重建 & 反向补齐
//
// 设计原则（参考 gsd）：
//   - manifest 是权威源；workflow.db 是快查索引
//   - rebuild-index：扫盘上的 manifest，批量 upsert 到 DB
//   - rebuild-manifest：从 DB 反向补老任务的 manifest（一次性迁移用）
// ──────────────────────────────────────────────

export interface RebuildIndexResult {
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: { taskId: string; message: string }[];
}

/**
 * 从所有 task-manifest.json 重建 DB 的 tasks 表。
 * 已存在记录按 manifest.updated_at 对比决定是否覆盖（manifest 赢）。
 */
export function rebuildIndexFromManifests(): RebuildIndexResult {
  const db = getDb();
  const result: RebuildIndexResult = { scanned: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };

  for (const taskId of listManifestTaskIds()) {
    result.scanned++;
    try {
      const m = readManifest(taskId);
      if (!m) {
        result.skipped++;
        continue;
      }
      const existing = getTask(taskId);
      const extraJson = JSON.stringify(m.extra ?? {});

      if (!existing) {
        db.run(
          "INSERT INTO tasks" +
          " (id, title, workflow, status, failure_count, channel, notify_target, extra," +
          "  created_at, updated_at, started_at, parent_task_id, parallel_index, parallel_group)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            m.taskId,
            m.title,
            m.workflow,
            m.status,
            m.failure_count,
            m.channel,
            m.notify_target,
            extraJson,
            m.created_at,
            m.updated_at,
            m.started_at,
            m.parent_task_id,
            m.parallel_index,
            m.parallel_group,
          ]
        );
        result.inserted++;
      } else {
        db.run(
          "UPDATE tasks SET title=?, status=?, failure_count=?, channel=?, notify_target=?," +
          " extra=?, updated_at=?, started_at=?, parent_task_id=?, parallel_index=?, parallel_group=?" +
          " WHERE id=?",
          [
            m.title,
            m.status,
            m.failure_count,
            m.channel,
            m.notify_target,
            extraJson,
            m.updated_at,
            m.started_at,
            m.parent_task_id,
            m.parallel_index,
            m.parallel_group,
            m.taskId,
          ]
        );
        result.updated++;
      }
    } catch (e: unknown) {
      result.errors.push({ taskId, message: e instanceof Error ? e.message : String(e) });
    }
  }
  log.info("rebuild-index 完成：扫描=%d 新增=%d 更新=%d 跳过=%d 失败=%d",
    result.scanned, result.inserted, result.updated, result.skipped, result.errors.length);
  return result;
}

export interface RebuildManifestResult {
  scanned: number;
  created: number;
  alreadyExists: number;
  errors: { taskId: string; message: string }[];
}

/**
 * 从 DB 反向给缺失 manifest 的任务补一份。
 * workflow_snapshot 尽力用当前 registry 的定义；若工作流已不存在，
 * 补一个 _legacy:true 的占位快照。
 *
 * 只补不改：已存在的 manifest 不覆盖。
 */
export function rebuildManifestsFromIndex(): RebuildManifestResult {
  const result: RebuildManifestResult = { scanned: 0, created: 0, alreadyExists: 0, errors: [] };

  for (const task of listTasks({})) {
    result.scanned++;
    try {
      if (readManifest(task.id)) {
        result.alreadyExists++;
        continue;
      }
      const snapshot = buildSnapshotFor(task.workflow);
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(task)) {
        if (TABLE_COLUMNS.has(k)) continue;
        extra[k] = v;
      }
      const m: TaskManifest = {
        version: MANIFEST_VERSION,
        taskId: task.id,
        title: task.title,
        workflow: task.workflow,
        workflow_snapshot: snapshot,
        status: task.status,
        failure_count: task.failure_count,
        channel: task.channel,
        notify_target: task.notify_target,
        created_at: task.created_at,
        updated_at: task.updated_at ?? task.created_at,
        started_at: task.started_at,
        parent_task_id: task.parent_task_id,
        parallel_index: task.parallel_index,
        parallel_group: task.parallel_group,
        extra,
        transitions: buildTransitionsFromLogs(task.id),
      };
      writeManifest(m);
      result.created++;
    } catch (e: unknown) {
      result.errors.push({ taskId: task.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  log.info("rebuild-manifest 完成：扫描=%d 新增=%d 已存在=%d 失败=%d",
    result.scanned, result.created, result.alreadyExists, result.errors.length);
  return result;
}

function buildSnapshotFor(workflowName: string): WorkflowSnapshot {
  const wf = getWorkflow(workflowName);
  if (wf) return snapshotWorkflow(wf);
  return {
    name: workflowName,
    initial_state: "",
    terminal_states: [],
    phases: [],
    _legacy: true,
  };
}

/**
 * 从 task_logs 表把历史状态转换还原成 manifest.transitions。
 * 按 id 升序扫，id 是自增主键，天然对应时间序。
 */
function buildTransitionsFromLogs(taskId: string): TransitionRecord[] {
  const db = getDb();
  const rows = db
    .query<{ from_status: string | null; to_status: string; trigger_name: string | null; note: string | null; created_at: string }, [string]>(
      "SELECT from_status, to_status, trigger_name, note, created_at FROM task_logs WHERE task_id = ? ORDER BY id ASC"
    )
    .all(taskId);
  return rows.map((r) => ({
    from: r.from_status ?? "",
    to: r.to_status,
    trigger: r.trigger_name ?? "",
    ts: r.created_at ?? now(),
    note: r.note,
  }));
}
