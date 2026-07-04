/**
 * 术语对照表 —— 单一真理源
 *
 * 业务标签 与 内核名 叠加显示，让放松状态下的开发者读得顺、
 * 懂行的自己仍能反向映射回 CLI。
 *
 * 增减条目请同步更新 TermKey union。
 */

export type TermKey = "jump_trigger";

export interface Term {
  /** 业务标签：中文 3~6 字，名词，避免 IT 黑话 */
  label: string;
  /** 内核名：原始 trigger / 概念名，用于反向映射回 CLI */
  internalName: string;
  /** 一句话说明：用于 tooltip body */
  description: string;
}

export const TERMS: Record<TermKey, Term> = {
  jump_trigger: {
    label: "驳回去向",
    internalName: "jump_trigger",
    description: "这个阶段被打回时，工作流会回退到哪一步重做",
  },
};
