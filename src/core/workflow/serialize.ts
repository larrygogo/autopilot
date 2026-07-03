import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ──────────────────────────────────────────────
// 工作流序列化 codec —— 文件文本 ↔ 结构对象 双向转换。
//
// 用户面**导入导出统一 JSON**（2026-06-18 决策：不再 yaml/json 双轨，跟内部 spec_json 真相一致）。
// examples 模板也已 JSON 化（yaml 移除 P1）：loadJsonWorkflow / seedTemplateWorkflow 读 workflow.json。
// yaml 能力**内部暂留**仅剩一处：native/template 行的 yaml_content 投影（getYaml/编辑器读、
// derived 克隆解析）——P2 删 yaml_content 列时随之移除。export/import 这两条**用户通道**只走 json。
//
// 叶子模块：只依赖 yaml 库 + JSON，不碰磁盘 / DB / registry。归一化（normalize* 输入容错）
// 属「加载」时的事，不在此 codec 内。
// ──────────────────────────────────────────────

export type WorkflowFormat = "yaml" | "json";

/** 解析工作流文本到结构对象（纯解析，不归一化）。json 走 JSON.parse，yaml 走 yaml.parse。 */
export function parseWorkflowText(text: string, format: WorkflowFormat): unknown {
  return format === "json" ? JSON.parse(text) : parseYaml(text);
}

/** 结构对象 → 文本（canonical）。yaml 2 空格缩进；json 2 空格 pretty + 末尾换行。 */
export function stringifyWorkflowDoc(doc: unknown, format: WorkflowFormat): string {
  return format === "json" ? JSON.stringify(doc, null, 2) + "\n" : stringifyYaml(doc, { indent: 2 });
}
