/**
 * submit_clarify 捕获位 — agent 调 submit_clarify 工具时把澄清结果写进这里，
 * callClaude 在 agent.chat/run 返回后 takeClarifyResult 读出来驱动后续逻辑。
 *
 * 窗口极短：agent 跑完 → take → 序列化为 rawText → parseClarifyResult 解析。
 * key = reqId。
 */

export interface CapturedClarifyResult {
  new_spec_md: string;
  summary: string | null;
  next_question: { agent_text: string; suggestions: string[] } | null;
  done: boolean;
  new_title: string | null;
}

const clarifyResults = new Map<string, CapturedClarifyResult>();

/** agent 调 submit_clarify → 写捕获位（同 reqId 多次调用以最后一次为准）。 */
export function captureClarifyResult(reqId: string, r: CapturedClarifyResult): void {
  clarifyResults.set(reqId, r);
}

/** callClaude 读结果（读后删，单消费）。无则 null。 */
export function takeClarifyResult(reqId: string): CapturedClarifyResult | null {
  const r = clarifyResults.get(reqId);
  clarifyResults.delete(reqId);
  return r ?? null;
}

/** 清残留（防 retry / 超时后陈旧捕获污染）。 */
export function clearClarifyResult(reqId: string): void {
  clarifyResults.delete(reqId);
}
