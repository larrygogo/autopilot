// ──────────────────────────────────────────────
// 工作流序列化 codec —— 文本 ↔ 结构对象 双向转换。
//
// 用户面**导入导出统一 JSON**（2026-06-18 决策：不再 yaml/json 双轨，跟内部 spec_json 真相一致）。
// yaml 能力已全部移除（P3，2026-07）：LLM 输出面（clarifier/author/extract）已转工具提交 + JSON 块，
// 冻结历史迁移（052/053）自带 yaml 解析（by design 各自 import yaml），不经此 codec。
//
// 叶子模块：只做 JSON，不碰磁盘 / DB / registry。归一化（normalize* 输入容错）
// 属「加载」时的事，不在此 codec 内。
// ──────────────────────────────────────────────

export type WorkflowFormat = "json";

/** 解析工作流文本到结构对象（纯解析，不归一化）。format 参数保留签名兼容，仅 "json"。 */
export function parseWorkflowText(text: string, _format: WorkflowFormat = "json"): unknown {
  return JSON.parse(text);
}

/** 结构对象 → 文本（canonical）。json 2 空格 pretty + 末尾换行。 */
export function stringifyWorkflowDoc(doc: unknown, _format: WorkflowFormat = "json"): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
