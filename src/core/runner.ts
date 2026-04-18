import { getTask } from "./db";
import { acquireLock, releaseLock } from "./infra";
import { log, setPhase, resetPhase, setTaskId } from "./logger";
import { appendTaskEvent } from "./task-logs";
import { runWithTaskContext } from "./task-context";
import { transition, InvalidTransitionError } from "./state-machine";
import { getWorkflow, getPhase, getPhaseFunc, buildTransitions, getTerminalStates, getNextPhase, isParallelPhase, type ParallelDefinition, type WorkflowDefinition } from "./registry";
import { closeAgents } from "../agents/registry";
import { emit } from "../daemon/event-bus";
import { archivePhaseArtifacts } from "./artifacts";

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

    // 先尝试识别为并行块（name 与顶层 parallel block 的 name 一致）
    const parallelEntry = workflow.phases.find(
      (p) => isParallelPhase(p) && p.parallel.name === phase,
    );
    if (parallelEntry && isParallelPhase(parallelEntry)) {
      await executeParallelGroup(taskId, parallelEntry.parallel, workflow);
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
    archivePhaseArtifacts(taskId, workflow, phase);

    // 自动推进下一阶段（若阶段函数没主动 transition）
    //
    // 规则：
    // - gate=true 的 phase：阶段函数完成后挂起到 awaiting_<phase>，等用户决断
    //   不自动 complete_trigger，不启动下一阶段
    // - 否则按原逻辑：若仍停留在 running_<phase> → complete_trigger + 启动下一阶段
    const current = getTask(taskId);
    if (current && current.status === phaseDef.running_state) {
      if (phaseDef.gate) {
        // 挂起到 awaiting_<phase>，等待 UI 决断
        try {
          transition(taskId, `await_${phase}`, { transitions: transitionTable });
          log.info("阶段完成，等待人工决断 [task=%s phase=%s]", taskId, phase);
          emit({ type: "phase:awaiting", payload: { taskId, phase } });
          appendTaskEvent(taskId, { type: "phase-awaiting", phase });
        } catch (e: unknown) {
          if (e instanceof InvalidTransitionError) {
            log.warn("await transition 失败 [task=%s phase=%s]: %s", taskId, phase, e.message);
          } else {
            throw e;
          }
        }
      } else if (phaseDef.complete_trigger) {
        try {
          transition(taskId, phaseDef.complete_trigger, { transitions: transitionTable });
        } catch (e: unknown) {
          if (e instanceof InvalidTransitionError) {
            log.debug("自动推进跳过（状态已变）[task=%s phase=%s]: %s",
              taskId, phase, e.message);
          } else {
            throw e;
          }
        }
        // runInBackground 启动下一阶段仅对顶层阶段自动做；并行块子阶段完成后
        // 由用户 / 并行协调层决定（避免跳过其他兄弟子阶段）
        const isChildOfParallel = workflow.phases.some(
          (p) => isParallelPhase(p) && p.parallel.phases.some((s) => s.name === phase)
        );
        if (!isChildOfParallel) {
          const nextPhase = getNextPhase(task.workflow, phase);
          if (nextPhase) {
            runInBackground(taskId, nextPhase);
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      log.warn("InvalidTransitionError [task=%s phase=%s]: %s", taskId, phase, err.message);
    } else {
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      log.error("阶段执行异常 [task=%s phase=%s]: %s", taskId, phase, errMsg);
      emit({ type: "phase:error", payload: { taskId, phase, error: errMsg } });
      appendTaskEvent(taskId, { type: "phase-error", phase, level: "error", message: errMsg });
      const wf = getWorkflow(getTask(taskId)?.workflow ?? "");
      if (wf) archivePhaseArtifacts(taskId, wf, phase);
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

// ──────────────────────────────────────────────
// 并行块执行
//
// 主任务状态在并行期间停在 waiting_<group>。子阶段不触发状态机
// （因为状态机单状态无法同时表达多个 running），而是并发调用
// 各自的 phaseFn；进度通过日志与事件流记录。
// 全部完成后：
//   - 全部成功 / fail_strategy=continue → transition(<group>_complete) → 推进下一阶段
//   - 有失败 且 fail_strategy=cancel_all → transition(<group>_fail) 走失败分支
// ──────────────────────────────────────────────

async function executeParallelGroup(
  taskId: string,
  parallel: ParallelDefinition,
  workflow: WorkflowDefinition,
): Promise<void> {
  const groupName = parallel.name;
  const transitionTable = buildTransitions(workflow);

  // fork：pending_<group> → waiting_<group>
  const forkTrigger = `start_${groupName}`;
  try {
    transition(taskId, forkTrigger, { transitions: transitionTable });
  } catch (err: unknown) {
    if (err instanceof InvalidTransitionError) {
      log.warn("并行块 %s fork 跳过（状态不匹配）[task=%s]: %s",
        groupName, taskId, err.message);
      return;
    }
    throw err;
  }

  const subNames = parallel.phases.map((p) => p.name);
  log.info("并行块开始 %s [task=%s 子阶段=%s]", groupName, taskId, subNames.join(", "));
  emit({ type: "phase:started", payload: { taskId, phase: groupName, label: parallel.name } });
  appendTaskEvent(taskId, { type: "parallel-started", phase: groupName, subs: subNames });

  // 并发执行子阶段 —— 不走状态机 transition，仅调用阶段函数
  const results = await Promise.allSettled(
    parallel.phases.map(async (sub) => {
      const subName = sub.name;
      try {
        appendTaskEvent(taskId, {
          type: "phase-started",
          phase: subName,
          label: sub.label,
          parallel: groupName,
        });
        // 子阶段的 log 标签独立
        // 注意：各并发分支共享全局 currentPhaseTag；短阶段里可能错乱，
        // 但对磁盘 phase-log 我们通过 runWithTaskContext + setPhase 在
        // 本分支作用域内设置；logger 会用当前的值。由于 Promise 并发时
        // setPhase 调用会互相覆盖，子阶段日志会记到哪个 phase-log 不稳定。
        // 折中：不 setPhase 而直接在日志消息里带 sub name。
        log.info("[parallel] %s 开始 [task=%s]", subName, taskId);
        const phaseFn = getPhaseFunc(workflow.name, subName);
        if (typeof phaseFn !== "function") {
          throw new Error(`阶段函数未定义：run_${subName}`);
        }
        await runWithTaskContext({ taskId, phase: subName }, async () => {
          await phaseFn(taskId);
        });
        log.info("[parallel] %s 完成 [task=%s]", subName, taskId);
        appendTaskEvent(taskId, { type: "phase-completed", phase: subName, parallel: groupName });
        archivePhaseArtifacts(taskId, workflow, subName);
        return { name: subName, ok: true as const };
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        log.error("[parallel] %s 失败 [task=%s]: %s", subName, taskId, msg);
        appendTaskEvent(taskId, {
          type: "phase-error",
          phase: subName,
          parallel: groupName,
          level: "error",
          message: msg,
        });
        archivePhaseArtifacts(taskId, workflow, subName);
        return { name: subName, ok: false as const, error: msg };
      }
    }),
  );

  const outcomes = results.map((r) => r.status === "fulfilled" ? r.value : { name: "?", ok: false, error: "rejected" });
  const failed = outcomes.filter((o) => !o.ok);
  const failStrategy = parallel.fail_strategy ?? "cancel_all";

  if (failed.length > 0 && failStrategy === "cancel_all") {
    const failTrigger = `${groupName}_fail`;
    log.warn("并行块 %s 有 %d 个子阶段失败（策略=cancel_all），触发失败分支 [task=%s]",
      groupName, failed.length, taskId);
    try {
      transition(taskId, failTrigger, { transitions: transitionTable });
    } catch (err: unknown) {
      if (!(err instanceof InvalidTransitionError)) throw err;
    }
    emit({ type: "phase:error", payload: { taskId, phase: groupName, error: `parallel failed: ${failed.map((f) => f.name).join(",")}` } });
    appendTaskEvent(taskId, { type: "parallel-failed", phase: groupName, failed: failed.map((f) => f.name) });
    return;
  }

  // join：waiting_<group> → 下一阶段 pending
  const joinTrigger = `${groupName}_complete`;
  try {
    transition(taskId, joinTrigger, { transitions: transitionTable });
  } catch (err: unknown) {
    if (!(err instanceof InvalidTransitionError)) throw err;
  }
  log.info("并行块 %s 完成（%d 成功 %d 失败）[task=%s]",
    groupName, outcomes.length - failed.length, failed.length, taskId);
  emit({ type: "phase:completed", payload: { taskId, phase: groupName } });
  appendTaskEvent(taskId, { type: "parallel-completed", phase: groupName, failed: failed.length });

  // Push 模型：启动下一阶段
  const nextPhase = getNextPhase(workflow.name, groupName);
  if (nextPhase) {
    runInBackground(taskId, nextPhase);
  }
}
