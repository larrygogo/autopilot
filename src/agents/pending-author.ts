/**
 * submit_workflow 捕获位 — agent 调 submit_workflow 工具时把生成的工作流写进这里，
 * callClaudeForAuthor 在 agent.run 返回后 takeAuthorResult 读出来驱动后续解析。
 *
 * key = callId（author 调用的唯一 ID）。
 */

export interface CapturedAuthorResult {
  name: string;
  description: string;
  spec: Record<string, unknown>; // 完整 workflow spec JSON 对象
}

const authorResults = new Map<string, CapturedAuthorResult>();

/** agent 调 submit_workflow → 写捕获位（同 callId 多次调用以最后一次为准）。 */
export function captureAuthorResult(callId: string, r: CapturedAuthorResult): void {
  authorResults.set(callId, r);
}

/** callClaudeForAuthor 读结果（读后删，单消费）。无则 null。 */
export function takeAuthorResult(callId: string): CapturedAuthorResult | null {
  const r = authorResults.get(callId);
  authorResults.delete(callId);
  return r ?? null;
}

/** 清残留（防陈旧捕获污染）。 */
export function clearAuthorResult(callId: string): void {
  authorResults.delete(callId);
}
