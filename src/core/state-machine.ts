import { getDb, getTask, now, TABLE_COLUMNS, PROTECTED_COLUMNS } from "./db";
import { emit } from "../daemon/event-bus";
import { appendTaskEvent } from "./task-logs";
import { appendTransition as appendManifestTransition } from "./manifest";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/** 转换表：{ fromStatus: [[trigger, toStatus], ...] } */
export type TransitionTable = Record<string, [string, string][]>;

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export interface TransitionOptions {
  transitions: TransitionTable;
  note?: string;
  extraUpdates?: Record<string, unknown>;
}


// ──────────────────────────────────────────────
// 核心函数
// ──────────────────────────────────────────────

/**
 * 执行状态转换（原子性），返回 [fromStatus, toStatus]
 * @throws InvalidTransitionError 如果转换非法
 */
export function transition(
  taskId: string,
  trigger: string,
  opts: TransitionOptions
): [string, string] {
  const db = getDb();

  let fromStatus = "";
  let toStatus = "";

  db.transaction(() => {
    const task = db
      .query<{ status: string; extra: string | null }, [string]>(
        "SELECT status, extra FROM tasks WHERE id = ?"
      )
      .get(taskId);

    if (!task) {
      throw new InvalidTransitionError(`任务不存在：${taskId}`);
    }

    fromStatus = task.status;
    const available = opts.transitions[fromStatus] ?? [];
    const match = available.find(([t]) => t === trigger);

    if (!match) {
      throw new InvalidTransitionError(
        `非法转换：状态 "${fromStatus}" 不支持触发器 "${trigger}"`
      );
    }

    toStatus = match[1];
    const ts = now();

    // 分离列字段和 extra 字段
    const colUpdates: string[] = ["status = ?", "updated_at = ?"];
    const colValues: unknown[] = [toStatus, ts];

    // 如果目标状态以 "running" 开头，更新 started_at
    if (toStatus.startsWith("running")) {
      colUpdates.push("started_at = ?");
      colValues.push(ts);
    }

    const extraUpdatesForCol: Record<string, unknown> = {};
    const extraUpdatesForJson: Record<string, unknown> = {};

    if (opts.extraUpdates) {
      for (const [key, value] of Object.entries(opts.extraUpdates)) {
        if (key === "extra" || key === "status" || key === "updated_at" || PROTECTED_COLUMNS.has(key)) continue;
        if (TABLE_COLUMNS.has(key)) {
          extraUpdatesForCol[key] = value;
        } else {
          extraUpdatesForJson[key] = value;
        }
      }
    }

    // 追加列字段更新
    for (const [key, value] of Object.entries(extraUpdatesForCol)) {
      colUpdates.push(`${key} = ?`);
      colValues.push(value);
    }

    // 处理 extra JSON 合并
    if (Object.keys(extraUpdatesForJson).length > 0) {
      let currentExtra: Record<string, unknown> = {};
      try {
        currentExtra = task.extra ? JSON.parse(task.extra) : {};
      } catch {
        currentExtra = {};
      }
      const mergedExtra = { ...currentExtra, ...extraUpdatesForJson };
      colUpdates.push("extra = ?");
      colValues.push(JSON.stringify(mergedExtra));
    }

    colValues.push(taskId, fromStatus);
    const result = db.run(
      `UPDATE tasks SET ${colUpdates.join(", ")} WHERE id = ? AND status = ?`,
      colValues as Parameters<typeof db.run>[1]
    );

    if (result.changes === 0) {
      throw new InvalidTransitionError(
        `并发冲突：任务 "${taskId}" 状态已被其他进程修改`
      );
    }

    // 插入日志
    db.run(
      "INSERT INTO task_logs (task_id, from_status, to_status, trigger_name, note, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
      [taskId, fromStatus, toStatus, trigger, opts.note ?? null, ts]
    );
  })();

  const transitionTs = now();
  appendManifestTransition(
    taskId,
    { from: fromStatus, to: toStatus, trigger, ts: transitionTs, note: opts.note ?? null },
    syncPatchFromTask(taskId),
  );

  emit({ type: "task:transition", payload: { taskId, from: fromStatus, to: toStatus, trigger } });
  appendTaskEvent(taskId, { type: "transition", from: fromStatus, to: toStatus, trigger, note: opts.note });

  return [fromStatus, toStatus];
}

/**
 * 从 DB 的最新任务状态派生 manifest 的同步 patch。
 * 用于 transition 完成后把 started_at、extra 等更新反映到 manifest。
 */
function syncPatchFromTask(taskId: string): {
  status: string;
  updated_at: string;
  started_at: string | null;
  extra: Record<string, unknown>;
  failure_count: number;
} | undefined {
  const t = getTask(taskId);
  if (!t) return undefined;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (TABLE_COLUMNS.has(k)) continue;
    extra[k] = v;
  }
  return {
    status: t.status,
    updated_at: t.updated_at,
    started_at: t.started_at,
    failure_count: t.failure_count,
    extra,
  };
}

/**
 * 强制状态转换（绕过转换表校验），保留审计日志。
 * 仅供 watcher 等系统组件在恢复卡死任务时使用。
 */
export function forceTransition(
  taskId: string,
  toStatus: string,
  note: string
): void {
  const db = getDb();

  let capturedFromStatus = "";
  let capturedTs = "";

  db.transaction(() => {
    const task = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM tasks WHERE id = ?"
      )
      .get(taskId);

    if (!task) {
      throw new InvalidTransitionError(`任务不存在：${taskId}`);
    }

    capturedFromStatus = task.status;
    capturedTs = now();

    db.run(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
      [toStatus, capturedTs, taskId]
    );

    db.run(
      "INSERT INTO task_logs (task_id, from_status, to_status, trigger_name, note, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
      [taskId, capturedFromStatus, toStatus, "force_transition", note, capturedTs]
    );
  })();

  appendManifestTransition(
    taskId,
    { from: capturedFromStatus, to: toStatus, trigger: "force_transition", ts: capturedTs, note },
    syncPatchFromTask(taskId),
  );

  emit({ type: "task:transition", payload: { taskId, from: capturedFromStatus, to: toStatus, trigger: "force_transition" } });
  appendTaskEvent(taskId, { type: "transition", from: capturedFromStatus, to: toStatus, trigger: "force_transition", note });
}

/**
 * 检查是否可以从当前状态触发指定 trigger
 */
export function canTransition(
  taskId: string,
  trigger: string,
  opts: TransitionOptions
): boolean {
  const task = getTask(taskId);
  if (!task) return false;
  const available = opts.transitions[task.status] ?? [];
  return available.some(([t]) => t === trigger);
}

/**
 * 获取当前状态下所有可用的 trigger 列表
 */
export function getAvailableTriggers(
  taskId: string,
  opts: TransitionOptions
): string[] {
  const task = getTask(taskId);
  if (!task) return [];
  const available = opts.transitions[task.status] ?? [];
  return available.map(([t]) => t);
}
