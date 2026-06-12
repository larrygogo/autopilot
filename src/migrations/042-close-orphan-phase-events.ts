/**
 * 关闭终态任务遗留的 open phase event（标 aborted）。
 *
 * 历史成因：closeOpenPhaseEvents 的调用散在各恢复/取消入口，workflow 内直接
 * transition cancel（驳回触顶）、watcher 恢复等路径曾漏调，终态任务留下
 * ended_at IS NULL 的 running 行 → 执行时间线多轮永远转圈、耗时累计到 now
 * （dogfood req-012 实锤：4 个僵尸轮显示 97h）。
 *
 * 自本迁移起新增路径已在 state-machine 终态转换单点收口；本迁移修存量。
 * ended_at 取该任务最后一条 task_logs 时间（兜底 started_at）——打断时刻的
 * 最优近似，保留「跑了多久」的真实信息。
 */
import type { Database } from "bun:sqlite";

export function up(db: Database): void {
  // 活跃前缀/中间态后缀之外 = 终态（与 state-machine.closeOpenEventsIfTerminal 同口径）
  db.run(`
    UPDATE task_phase_events SET
      status = 'aborted',
      ended_at = COALESCE(
        (SELECT CAST(strftime('%s', MAX(l.created_at)) AS INTEGER) * 1000
           FROM task_logs l WHERE l.task_id = task_phase_events.task_id),
        started_at
      )
    WHERE ended_at IS NULL
      AND task_id IN (
        SELECT id FROM tasks
        WHERE status NOT LIKE 'pending~_%' ESCAPE '~'
          AND status NOT LIKE 'running~_%' ESCAPE '~'
          AND status NOT LIKE 'awaiting~_%' ESCAPE '~'
          AND status NOT LIKE 'waiting~_%' ESCAPE '~'
          AND status NOT LIKE '%~_rejected' ESCAPE '~'
      )
  `);
}
