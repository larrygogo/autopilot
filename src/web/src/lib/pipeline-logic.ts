/**
 * 流水线页纯逻辑（可单测，与 run-view-logic 同款抽法）。
 */

interface RunTaskLike {
  id: string;
  requirement_id?: string | null;
}

interface RequirementLike {
  task_id?: string | null;
}

/**
 * run 多历史过滤（v2 R2）：一个需求重跑后会有多个历史 run（task），流水线每需求
 * 只显示 requirement.task_id 指向的最新 run，避免一件工作铺多行。
 *  - 无关联需求的任务照旧显示（历史游离任务）
 *  - 需求已不在列表（被删等）的任务照旧显示，避免误吞
 *  - 需求存在但 task_id 不指向该任务（历史 run / 并行块子任务）→ 隐藏
 */
export function filterLatestRunTasks<T extends RunTaskLike>(
  tasks: T[],
  reqById: Record<string, RequirementLike | undefined>,
): T[] {
  return tasks.filter((t) => {
    if (!t.requirement_id) return true;
    const req = reqById[t.requirement_id];
    if (!req) return true;
    return req.task_id === t.id;
  });
}
