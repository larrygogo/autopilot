/**
 * 工作流声明层的枚举语义（需求中心架构 v2 R5）。
 *
 * 分层红线：registry（core）只透传 requires/delivers 形状 + 缺省派生；
 * 'pr'/'artifacts' 枚举判断、三闸门（clarifying / enqueue / setWorkflow）的拦截语义全在这里
 * —— daemon 持有行为语义，core 零业务知识。
 *
 * 闸门按 `req.workflow ?? "dev"` 的**当前所选工作流**动态校验：
 *   - requires.git === true       → 必须有代码库（集合非空）
 *   - "optional" / false          → 放行（集合空时确认 input_mode='none'，走 clarifier 纯文本模式）
 *   - 交叉校验（enqueue）         → 集合空 × delivers==='pr' = 拒（PR 无处可开）
 * 工作流未注册（老 dev 副本缺失等）→ 保守按 requires.git=true（与改造前行为一致）。
 */

import { getWorkflow, getWorkflowGitRequirement } from "../core/workflow/registry";

export type DeliveryKind = "pr" | "artifacts" | "auto";

export interface WorkflowDecl {
  name: string;
  /** git 输入要求（含 sandbox.git 缺省派生）；工作流未注册时保守 true */
  requiresGit: boolean | "optional";
  /** 产出形态；非法/缺省一律 "auto"（事实推断，运行时以 hasPr/hasDeliveries 为准） */
  delivers: DeliveryKind;
  /** 工作流是否真实注册（未注册时上面两项是保守缺省） */
  registered: boolean;
}

/** 解析需求所选工作流（NULL 回退默认 "dev"）的声明。 */
export function resolveWorkflowDecl(workflowName: string | null | undefined): WorkflowDecl {
  const name = workflowName?.trim() || "dev";
  const wf = getWorkflow(name);
  if (!wf) return { name, requiresGit: true, delivers: "auto", registered: false };
  const d = typeof wf.delivers === "string" ? wf.delivers.trim() : "";
  return {
    name,
    requiresGit: getWorkflowGitRequirement(wf),
    delivers: d === "pr" || d === "artifacts" ? d : "auto",
    registered: true,
  };
}

/**
 * 三闸门共用校验：所选工作流 × 代码库集合空/非空。
 * 返回 null = 通过；string = 人话拒绝理由（clarifying/enqueue 抛错、setWorkflow 作 warning）。
 *
 * @param crossCheckDelivers enqueue 才开（集合空 × delivers:pr 交叉拒）；
 *   clarifying 不开 —— 澄清期还可能换工作流，过早拦截反而卡死探索
 */
export function validateWorkflowInput(
  workflowName: string | null | undefined,
  hasWorkspaces: boolean,
  opts?: { crossCheckDelivers?: boolean },
): string | null {
  const decl = resolveWorkflowDecl(workflowName);
  if (hasWorkspaces) return null;
  if (decl.requiresGit === true) {
    return `工作流「${decl.name}」需要代码库（requires.git=true${decl.registered ? "" : "，工作流未注册按保守缺省"}），` +
      `当前需求未关联任何代码库。请先确认代码库，或换用不要求代码库的工作流。`;
  }
  if (opts?.crossCheckDelivers && decl.delivers === "pr") {
    return `工作流「${decl.name}」交付 PR（delivers: pr），但本需求未关联任何代码库——PR 无处可开。` +
      `请关联代码库，或换用产物交付类工作流。`;
  }
  return null;
}
