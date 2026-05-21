import { log } from "./logger";
import {
  getDueSchedules,
  markScheduleFired,
  computeNextRun,
  type Schedule,
} from "./schedules";
import { startTaskFromTemplate } from "./task-factory";
import { sendPromptToTask } from "./task-send-prompt";
import { getTask } from "./db";
import { appendTaskEvent } from "./task-logs";

/**
 * 扫描并触发所有到期的 schedule。由 daemon 定时调用。
 * 按配置不做并发保护：上一次任务是否结束与下次触发无关。
 */
export async function runScheduledTasks(): Promise<void> {
  const nowIso = new Date().toISOString();
  const due = getDueSchedules(nowIso);
  if (due.length === 0) return;

  for (const sch of due) {
    await fireSchedule(sch);
  }
}

async function fireSchedule(sch: Schedule): Promise<void> {
  try {
    // Phase 5: send_prompt 模式 — 对已有 task 追加 prompt（spec §3.6）
    if (sch.mode === "send_prompt") {
      if (!sch.target_task_id || !sch.prompt) {
        log.warn("schedule %s mode=send_prompt 但缺 target_task_id/prompt，跳过", sch.id);
        markScheduleFired(sch.id, sch.last_task_id ?? "", null, true);
        return;
      }
      const targetTask = getTask(sch.target_task_id);
      if (!targetTask) {
        log.warn("schedule %s 目标 task %s 不存在，disable", sch.id, sch.target_task_id);
        markScheduleFired(sch.id, sch.last_task_id ?? "", null, true);
        return;
      }

      const result = sendPromptToTask(sch.target_task_id, sch.prompt, { source: "schedule" });
      if (!result.accepted) {
        // 目标终态等情况：disable schedule + 写 task log 解释
        log.warn(
          "schedule %s 注入失败 task=%s reason=%s，disable",
          sch.id, sch.target_task_id, result.reason ?? "?",
        );
        try {
          appendTaskEvent(sch.target_task_id, {
            type: "scheduled-prompt-skipped",
            scheduleId: sch.id,
            reason: result.reason ?? "rejected",
          });
        } catch { /* best-effort */ }
        markScheduleFired(sch.id, sch.target_task_id, null, true);
        return;
      }

      const { nextRunAt, disable } = computeNextState(sch);
      markScheduleFired(sch.id, sch.target_task_id, nextRunAt, disable);
      log.info(
        "schedule %s send_prompt → task %s（mode=%s, next_run_at=%s, disable=%s）",
        sch.id, sch.target_task_id, result.mode, nextRunAt ?? "—", String(disable),
      );
      return;
    }

    // mode=start_task：原行为
    const task = await startTaskFromTemplate({
      workflow: sch.workflow,
      title: sch.title,
      requirement: sch.requirement ?? undefined,
    });

    const { nextRunAt, disable } = computeNextState(sch);
    markScheduleFired(sch.id, task.id, nextRunAt, disable);

    log.info(
      "schedule %s 触发 → task %s（next_run_at=%s, disable=%s）",
      sch.id,
      task.id,
      nextRunAt ?? "—",
      String(disable)
    );
  } catch (e: unknown) {
    // 触发失败：不更新 last_run_at，把 next_run_at 往后推以避免风暴。
    // cron 重算下次，once 直接停用（避免每 tick 都失败）。
    const msg = e instanceof Error ? e.message : String(e);
    log.error("schedule %s 触发失败：%s", sch.id, msg);
    try {
      if (sch.type === "cron" && sch.cron_expr) {
        const nextRunAt = computeNextRun(sch.cron_expr, sch.timezone, new Date());
        markScheduleFired(sch.id, sch.last_task_id ?? "", nextRunAt, false);
      } else {
        markScheduleFired(sch.id, sch.last_task_id ?? "", null, true);
      }
    } catch (e2: unknown) {
      log.error(
        "schedule %s 失败后推进 next_run_at 也失败：%s",
        sch.id,
        e2 instanceof Error ? e2.message : String(e2)
      );
    }
  }
}

function computeNextState(sch: Schedule): { nextRunAt: string | null; disable: boolean } {
  if (sch.type === "once") {
    return { nextRunAt: null, disable: true };
  }
  // cron：从现在算下一个（而非从 last next_run_at），避免漏跑堆积时反复补跑
  const nextRunAt = computeNextRun(sch.cron_expr!, sch.timezone, new Date());
  return { nextRunAt, disable: false };
}
