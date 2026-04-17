import { getTask } from "./db";
import { acquireLock, releaseLock } from "./infra";
import { log, setPhase, resetPhase, setTaskId } from "./logger";
import { appendTaskEvent } from "./task-logs";
import { runWithTaskContext } from "./task-context";
import { transition, InvalidTransitionError } from "./state-machine";
import { getWorkflow, getPhase, getPhaseFunc, buildTransitions, getTerminalStates } from "./registry";
import { closeAgents } from "../agents/registry";
import { emit } from "../daemon/event-bus";

// ──────────────────────────────────────────────
// Push 模型：非阻塞启动阶段
// ──────────────────────────────────────────────

/**
 * 非阻塞启动阶段执行（Push 模型）。
 * 使用 setImmediate 将 executePhase 放入事件队列，立即返回。
 */
export function runInBackground(taskId: string, phase: string): void {
  setImmediate(() => {
    executePhase(taskId, phase).catch((err: unknown) => {
      log.error("runInBackground 意外错误 [task=%s phase=%s]: %s", taskId, phase, String(err));
    });
  });
}

// ──────────────────────────────────────────────
// 阶段执行引擎
// ──────────────────────────────────────────────

/**
 * 执行指定任务的指定阶段。
 * - 获取锁（防止并发双重执行）
 * - 校验任务与工作流存在
 * - 检查当前状态是否需要执行 trigger（若已处于 running 则跳过）
 * - 调用阶段函数
 * - 异常处理：InvalidTransitionError → warn，其他 → error
 * - finally：重置日志标签 + 释放锁
 */
export async function executePhase(taskId: string, phase: string): Promise<void> {
  // 尝试获取锁
  const locked = acquireLock(taskId);
  if (!locked) {
    log.warn("任务 %s 已被锁定，跳过阶段 %s 执行", taskId, phase);
    return;
  }

  try {
    // 加载任务
    const task = getTask(taskId);
    if (!task) {
      log.warn("任务不存在，跳过执行 [task=%s phase=%s]", taskId, phase);
      return;
    }

    // 加载工作流
    const workflow = getWorkflow(task.workflow);
    if (!workflow) {
      log.error("工作流未注册：%s [task=%s]", task.workflow, taskId);
      return;
    }

    // 加载阶段定义和函数
    const phaseDef = getPhase(task.workflow, phase);
    if (!phaseDef) {
      log.error("阶段不存在：%s [workflow=%s task=%s]", phase, task.workflow, taskId);
      return;
    }

    const phaseFn = getPhaseFunc(task.workflow, phase);
    if (!phaseFn) {
      log.error("阶段函数未定义：%s [workflow=%s task=%s]", phase, task.workflow, taskId);
      return;
    }

    // 设置日志标签
    setPhase(phase, phaseDef.label);
    setTaskId(taskId);

    // 构建转换表
    const transitionTable = buildTransitions(workflow);

    // 检查当前状态：若已在 running 状态则跳过 trigger，否则执行 trigger
    const currentStatus = task.status;
    const runningState = phaseDef.running_state;
    const triggerName = phaseDef.trigger;

    if (currentStatus !== runningState) {
      // 需要先执行 trigger 将状态从 pending → running
      try {
        transition(taskId, triggerName, { transitions: transitionTable });
        log.info("状态转换：%s → %s [触发器=%s]", currentStatus, runningState, triggerName);
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          log.warn("无效状态转换，跳过执行 [task=%s phase=%s status=%s]: %s",
            taskId, phase, currentStatus, err.message);
          return;
        }
        throw err;
      }
    } else {
      log.info("任务已处于 running 状态，直接执行阶段函数 [task=%s phase=%s]", taskId, phase);
    }

    // 执行阶段函数
    log.info("开始执行阶段 %s [task=%s]", phase, taskId);
    emit({ type: "phase:started", payload: { taskId, phase, label: phaseDef.label } });
    appendTaskEvent(taskId, { type: "phase-started", phase, label: phaseDef.label });
    await runWithTaskContext({ taskId, phase }, async () => {
      await phaseFn(taskId);
    });
    log.info("阶段执行完成：%s [task=%s]", phase, taskId);
    emit({ type: "phase:completed", payload: { taskId, phase } });
    appendTaskEvent(taskId, { type: "phase-completed", phase });
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      log.warn("InvalidTransitionError [task=%s phase=%s]: %s", taskId, phase, err.message);
    } else {
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      log.error("阶段执行异常 [task=%s phase=%s]: %s", taskId, phase, errMsg);
      emit({ type: "phase:error", payload: { taskId, phase, error: errMsg } });
      appendTaskEvent(taskId, { type: "phase-error", phase, level: "error", message: errMsg });
    }
  } finally {
    resetPhase();
    releaseLock(taskId);
    // 只在任务进入终态时才关闭 agent 连接，避免破坏会话复用
    const task = getTask(taskId);
    if (task) {
      const terminalStates = new Set(getTerminalStates(task.workflow));
      terminalStates.add("done");
      terminalStates.add("cancelled");
      if (terminalStates.has(task.status)) {
        await closeAgents(task.workflow).catch(() => {});
      }
    }
  }
}
