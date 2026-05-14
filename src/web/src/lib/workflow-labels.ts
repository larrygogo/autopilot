/**
 * 工作流相关的中文标签映射，PhasePipeline / StateMachineGraph / TaskProgressCard 共用。
 *
 * 阶段名（phase name）和状态机 trigger 名一般是约定的英文 snake_case，
 * 这里把常见的几类翻译成中文，命中即用，未命中保持原文。
 *
 * 显示优先级（pickPhaseLabel）：用户在 yaml 写的 label > PHASE_LABEL 静态兜底 > 原 name。
 * 注意：registry 在 expandPhaseDefaults 会把缺省 label 填成 name.toUpperCase()——
 * 这种值不算"用户真填的 label"，要识别出来回退到下一级。
 */

/**
 * 选取阶段显示名 — 所有 UI 显示阶段名的位置都应通过这个函数获取，避免
 * 节点 / drawer / breadcrumb 等显示不一致。
 */
export function pickPhaseLabel(item: { name: string; label?: string | null }): string {
  return userPhaseLabel(item) ?? PHASE_LABEL[item.name] ?? item.name;
}

/**
 * 仅返回"用户在 yaml 写的"label。yaml 没写时 registry 兜底 label = name.toUpperCase()，
 * 该函数会识别这种兜底并返回 undefined，让调用方能区分"真有中文名"vs"只是英文 fallback"。
 */
export function userPhaseLabel(item: { name: string; label?: string | null }): string | undefined {
  if (typeof item.label !== "string" || item.label === "") return undefined;
  if (item.label === item.name.toUpperCase()) return undefined;
  return item.label;
}

/** Phase 名 → 中文 */
export const PHASE_LABEL: Record<string, string> = {
  // req_dev / dev 工作流
  design: "方案设计",
  review: "方案评审",
  develop: "代码开发",
  code_review: "代码审查",
  submit_pr: "提交 PR",
  await_review: "等待 PR review",
  fix_revision: "PR 修复",
  // doc_gen
  generate: "生成文档",
  review_doc: "文档评审",
  // data_pipeline
  extract: "数据抽取",
  validate_data: "数据校验",
  transform: "数据转换",
  load: "数据入库",
  // parallel_build
  prepare: "准备",
  build_frontend: "前端构建",
  build_backend: "后端构建",
  integration_test: "集成测试",
  // req_review
  req_analysis: "需求分析",
  req_review: "需求评审",
};

/** 状态机 trigger 名 → 中文短描述 */
export function triggerLabel(trigger: string): string {
  if (trigger === "cancel") return "取消";
  if (trigger === "start") return "开始";
  if (trigger.startsWith("start_")) {
    const phase = trigger.slice("start_".length);
    return `开始 ${PHASE_LABEL[phase] ?? phase}`;
  }
  if (trigger.endsWith("_complete")) return "完成 ✓";
  if (trigger.endsWith("_fail")) return "失败 ✗";
  if (trigger.endsWith("_reject")) return "驳回 ↩";
  if (trigger.startsWith("retry_")) {
    const phase = trigger.slice("retry_".length);
    return `重试 ${PHASE_LABEL[phase] ?? phase}`;
  }
  if (trigger === "force_transition") return "强制转换";
  return trigger;
}

/** 状态节点 id（pending_design / running_design / design_complete / done / cancelled）→ 中文短描述 */
export function nodeLabel(id: string): string {
  if (id === "done") return "已完成";
  if (id === "cancelled") return "已取消";
  if (id === "failed") return "失败";
  const m = id.match(/^(pending|running|complete|reject)_(.+)$/);
  if (m) {
    const [, kind, phase] = m;
    const phaseZh = PHASE_LABEL[phase] ?? phase;
    if (kind === "pending") return `待 · ${phaseZh}`;
    if (kind === "running") return `执行中 · ${phaseZh}`;
    if (kind === "complete") return `${phaseZh} 完成`;
    if (kind === "reject") return `${phaseZh} 驳回`;
  }
  // X_complete 形式
  if (id.endsWith("_complete")) {
    const phase = id.slice(0, -"_complete".length);
    return `${PHASE_LABEL[phase] ?? phase} 完成`;
  }
  return id;
}

/** 提取 phase 名（已与 nodeLabel 不同：用于反查 PHASE_LABEL） */
export function phaseFromStatusOrId(idOrStatus: string): string | null {
  const m = idOrStatus.match(/^(?:pending|running|complete|start|reject|failed)_(.+)$/);
  if (m) return m[1];
  if (idOrStatus.endsWith("_complete")) return idOrStatus.slice(0, -"_complete".length);
  return null;
}
