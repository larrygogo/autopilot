import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ──────────────────────────────────────────────
// 工作流序列化 codec —— 文件文本 ↔ 结构对象 的双向转换，统一 yaml / json 两种格式。
//
// 这是「DB 为运行时真相源，YAML/JSON 只是导入导出交换格式」定位的地基（方案 C）：
// 工作流的声明部分本就是纯数据（phases/agent/prompt/decision…），yaml 和 json 只是它的
// 两种序列化。导入 = parse(文本) → 结构对象 → 落 DB；导出 = DB 行 → 序列化成任一格式。
//
// 叶子模块：只依赖 yaml 库 + JSON，不碰磁盘 / DB / registry。归一化（normalize* 输入容错、
// workspace→sandbox 改名等）属「加载 / 导入」时的事，不在此 codec 内（导出保真：吐什么存什么）。
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

/**
 * 把「DB 里存的 yaml_content（或 file 工作流磁盘上的 yaml）」导出成目标格式。
 * - yaml：**原样返回**（保留注释 / 排版，与历史 export 行为一致，零信息损失）。
 * - json：parseYaml → 原生结构 json（注释在 json 里本就无处安放，是格式固有的）。
 */
export function exportWorkflowContent(yamlContent: string, format: WorkflowFormat): string {
  if (format === "yaml") return yamlContent;
  return JSON.stringify(parseYaml(yamlContent), null, 2) + "\n";
}

/**
 * 按文件扩展名优先、内容嗅探兜底，判定文本格式。
 * .json→json；.yaml/.yml→yaml；无扩展名时按内容首个非空字符（`{` / `[` = json，否则 yaml）。
 */
export function detectFormat(text: string, ext?: string): WorkflowFormat {
  const e = (ext ?? "").toLowerCase();
  if (e === ".json") return "json";
  if (e === ".yaml" || e === ".yml") return "yaml";
  const t = text.replace(/^﻿/, "").trimStart(); // 去 BOM
  return t.startsWith("{") || t.startsWith("[") ? "json" : "yaml";
}
