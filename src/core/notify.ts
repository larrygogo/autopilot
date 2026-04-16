import { log } from "./logger";
import { getWorkflow } from "./registry";
import type { Task } from "./db";

/**
 * 发送任务通知。
 * 优先调用工作流定义的 notify_func；未定义则降级为日志输出。
 */
export async function notify(
  task: Task,
  message: string,
  event = "info"
): Promise<void> {
  const workflow = getWorkflow(task.workflow);
  if (workflow?.notify_func) {
    try {
      await Promise.resolve(workflow.notify_func(task, message));
      return;
    } catch (e: any) {
      log.warn(
        "notify_func 执行失败 [task=%s workflow=%s]: %s",
        task.id,
        task.workflow,
        e.message
      );
    }
  }

  // 兜底：日志输出
  log.info("[%s] task=%s workflow=%s — %s", event, task.id, task.workflow, message);
}
