/**
 * 框架内置「artifacts 交付器」——把 spawn-free 的机械交付（promote 沙盒产物到需求 deliveries/
 * 并落表）收成框架原语，用户工作流只在 phase 上声明 `deliver: artifacts` 即可，不写 ts。
 *
 * 触发：bindPhaseFunc 见到 phase.deliver === "artifacts" 就绑本模块的 runner。
 * 与 dev 的 PR 交付（仍是 workflow 的「肉」）井水不犯河水：artifacts 交付无 spawn、无凭证、
 * 只调框架 single-writer 原语 deliverArtifacts，故安全收进框架；PR 交付有 git/gh spawn，留交付层。
 *
 * 闭包内动态 import 内部依赖：bindPhaseFunc(registry) 静态 import 本模块，本模块若静态 import
 * registry/requirements 会成 load-time 循环，故内部依赖一律延迟到运行时取（与 runner 同范式）。
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const DELIVERABLES_DIR = "deliverables";

export function makeArtifactDeliverRunner(phaseName: string): (taskId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    const { getTask } = await import("../db");
    const { transition } = await import("../state-machine");
    const { getWorkflow, buildTransitions } = await import("./registry");
    const { getCurrentSandboxDir } = await import("../task/context");
    const { deliverArtifacts } = await import("../requirements/deliveries");

    const task = getTask(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    const root = getCurrentSandboxDir() ?? (task["repo_path"] as string | undefined);
    if (!root) throw new Error("拿不到沙盒目录（getCurrentSandboxDir 与 repo_path 都为空）");

    const src = join(root, DELIVERABLES_DIR);
    if (!existsSync(src)) {
      throw new Error(`找不到产物目录：${src}——上游阶段应把交付物写到 \${DELIVERABLES} 占位符指向的目录`);
    }

    // SUMMARY.md 作本轮交付摘要（验收 UI 展示）；读不到不阻塞
    let summary: string | undefined;
    try {
      summary = readFileSync(join(src, "SUMMARY.md"), "utf-8").slice(0, 2000);
    } catch {
      /* ignore */
    }

    // promote 出沙盒：交付物生命周期属于需求；round = 现有 max+1（驳回重交递增）
    const delivery = deliverArtifacts(taskId, src, summary);

    const wf = getWorkflow(task.workflow);
    if (!wf) throw new Error(`工作流不存在：${task.workflow}`);
    transition(taskId, `${phaseName}_complete`, {
      transitions: buildTransitions(wf),
      note: `产物已交付：需求 ${delivery.requirement_id} 第 ${delivery.round} 轮（${delivery.path}/），等待需求级人工验收`,
    });
  };
}
