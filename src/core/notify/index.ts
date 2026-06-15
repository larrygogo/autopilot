import { log } from "../logger";
import { getWorkflow } from "../registry";
import type { Task } from "../db";
import { loadNotifyDrivers } from "../config";
import { getEnabledDrivers, type NotifyDriver, type NotifyEvent } from "./drivers";

/**
 * 发送任务通知。
 * 调用顺序：
 *   1. workflow.notify_func（若工作流定义了）
 *   2. 所有已注册且 enabled 的系统通知 driver（按 on_events 过滤，错误吞掉）
 *   3. log.info 兜底（无论上面是否触发都会记录，便于排错）
 *
 * driver 列表懒加载 + 缓存：daemon 启动后第一次 notify() 触发；config.yaml 改动后需 daemon 重启生效。
 */
export async function notify(
  task: Task,
  message: string,
  event: NotifyEvent = "info",
): Promise<void> {
  // 1. workflow notify_func（保留原路径）
  const workflow = getWorkflow(task.workflow);
  if (workflow?.notify_func) {
    try {
      await Promise.resolve(workflow.notify_func(task, message));
    } catch (e: unknown) {
      log.warn(
        "notify_func 执行失败 [task=%s workflow=%s]: %s",
        task.id,
        task.workflow,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // 2. system drivers
  const drivers = await getCachedDrivers();
  for (const driver of drivers) {
    try {
      await driver.send({ task, message, event });
    } catch (e: unknown) {
      log.warn(
        "notify driver %s 失败 [task=%s event=%s]: %s",
        driver.name, task.id, event,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // 3. log 兜底
  log.info("[%s] task=%s workflow=%s — %s", event, task.id, task.workflow, message);
}

// ──────────────────────────────────────────────
// driver 缓存
// ──────────────────────────────────────────────

let _drivers: NotifyDriver[] | null = null;

async function getCachedDrivers(): Promise<NotifyDriver[]> {
  if (_drivers !== null) return _drivers;
  try {
    const configs = loadNotifyDrivers();
    _drivers = await getEnabledDrivers(configs);
    if (_drivers.length > 0) {
      log.info("notify driver 注册：%s", _drivers.map(d => d.name).join(", "));
    }
  } catch (e: unknown) {
    log.warn("notify driver 加载失败：%s", e instanceof Error ? e.message : String(e));
    _drivers = [];
  }
  return _drivers;
}

/** 重置 driver 缓存（测试或 config 改动后手动重载用）。 */
export function _resetNotifyDriversForTest(): void {
  _drivers = null;
}
