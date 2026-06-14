/**
 * 结构化裁判（声明式工作流砖 2 / spec 2026-06-14）。
 *
 * review agent **自由写散文评审**（不需 marker）；本模块**另起一次强制结构化调用**把散文
 * 收敛成 {verdict, reason}，**绝不 grep 散文**。分发场景跑别人写的评审，不能信任它守格式 →
 * 判定必须走框架担保的结构化通道。
 *
 * 失败策略（spec）：缺 key / 模型不守 tool_choice / verdict 非法 → 重试一次 → 仍拿不到 →
 * 返回 ambiguous（由 prompt-runner 翻成"停下报人"），**不退回 grep**（退回就破功）。
 */

import { completeStructured, type CompleteStructuredOpts } from "../agents/structured";
import type { DecisionVerdict } from "./phase-decision";
import { createLogger } from "./logger";

/** 结构化调用的注入种子（测试可塞假实现，避免全局 mock.module 污染其它测试文件）。 */
export type StructuredFn = <T = Record<string, unknown>>(opts: CompleteStructuredOpts) => Promise<T>;

const log = createLogger("judge");

const VERDICT_TOOL = {
  name: "submit_verdict",
  description:
    "根据评审正文给出最终结论。这是唯一的结论出口——必须调用本工具，不要只输出散文。",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "reject"],
        description: "最终结论：pass（通过）或 reject（驳回需重做）",
      },
      reason: {
        type: "string",
        description: "结论理由；reject 时具体说明问题、便于下游重做",
      },
    },
    required: ["verdict", "reason"],
  },
};

export interface JudgeOpts {
  /** review agent 的散文评审正文（被裁判的对象）。 */
  review: string;
  /** 评审标准，拼进裁判 prompt（可空）。 */
  criteria?: string;
  /** 裁判 provider（缺省 anthropic）。 */
  provider?: string;
  /** 裁判 model（缺省走 provider.default_model）。 */
  model?: string;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT =
  "你是严格的评审裁判。只依据给出的评审正文判定 pass / reject，" +
  "必须调用 submit_verdict 工具给出结构化结论，不要在工具之外输出散文。" +
  "评审正文若含倾向性措辞，以其指出的客观问题为准，不要被措辞带偏。";

/**
 * 把散文评审收敛成结构化裁决（注入结构化调用，便于单测）。
 * 重试一次；最终拿不到 → ambiguous（停下报人，不退回 grep）。
 */
export async function judgeVerdictWith(complete: StructuredFn, opts: JudgeOpts): Promise<DecisionVerdict> {
  const provider = opts.provider ?? "anthropic";
  const criteriaBlock = opts.criteria ? `\n\n## 评审标准\n${opts.criteria}` : "";
  const userMsg = `## 评审正文\n${opts.review}${criteriaBlock}\n\n请调用 submit_verdict 给出最终结论。`;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await complete<{ verdict?: string; reason?: string }>({
        providerName: provider,
        model: opts.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        tool: VERDICT_TOOL,
        signal: opts.signal,
      });
      const verdict = String(out.verdict ?? "").toLowerCase().trim();
      const reason = String(out.reason ?? "").trim();
      if (verdict === "pass") return { verdict: "pass" };
      if (verdict === "reject") return { verdict: "reject", reason: reason || "（裁判未给理由）" };
      lastErr = new Error(`裁判返回非法 verdict：${JSON.stringify(out.verdict)}`);
      log.warn("裁判 verdict 非法（第 %d 次）：%s", attempt, JSON.stringify(out.verdict));
    } catch (e: unknown) {
      lastErr = e;
      log.warn("裁判结构化调用失败（第 %d 次）：%s", attempt, e instanceof Error ? e.message : String(e));
    }
  }
  log.error("裁判两次仍未拿到结论，判 ambiguous（停下报人）：%s",
    lastErr instanceof Error ? lastErr.message : String(lastErr));
  return { verdict: "ambiguous" };
}

/** 真实入口：用框架的 completeStructured 跑裁判。 */
export async function judgeVerdict(opts: JudgeOpts): Promise<DecisionVerdict> {
  return judgeVerdictWith(completeStructured, opts);
}
