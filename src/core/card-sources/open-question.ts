import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { listQuestionsByRequirement } from "../requirement-questions";
import { getRequirementById } from "../requirements";
import { getDb } from "../db";

function buildCard(q: { id: string; requirement_id: string; agent_text: string; created_at: number }): NowCard {
  const preview = q.agent_text.length > 80 ? q.agent_text.slice(0, 80) + "…" : q.agent_text;
  return {
    id: `open-question:${q.id}`,
    priority: "P1",
    category: "decision",
    title: `AI 提了个问题`,
    subtitle: `Req ${q.requirement_id} · ${preview}`,
    related: { type: "requirement", id: q.requirement_id },
    actions: [
      { label: "回答", kind: "primary", href: `/requirements/${q.requirement_id}` },
    ],
    dismissable: false,
    created_at: Math.floor(q.created_at / 1000),
  };
}

/** 跨需求拉所有 open 问题 — requirement-questions.ts 没有 listAll 接口，直接 SQL 查 */
function listAllOpenQuestions(): Array<{ id: string; requirement_id: string; agent_text: string; created_at: number }> {
  // INNER JOIN 过滤孤儿（requirement 已被删但 question 残留的情况）
  return getDb().query<
    { id: string; requirement_id: string; agent_text: string; created_at: number },
    []
  >(`
    SELECT q.id, q.requirement_id, q.agent_text, q.created_at
    FROM requirement_questions q
    INNER JOIN requirements r ON r.id = q.requirement_id
    WHERE q.status = 'open'
  `).all();
}

export function createOpenQuestionSource(): CardSource {
  /** 跟踪 source 已知的 open question ids，用于 onEvent diff */
  const known = new Set<string>();

  return {
    name: "open-question",
    subscribes: ["requirement:questions-updated", "requirement:all-questions-resolved"],

    async scan() {
      const qs = listAllOpenQuestions();
      known.clear();
      for (const q of qs) known.add(q.id);
      return qs.map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "requirement:questions-updated"
          && event.type !== "requirement:all-questions-resolved") {
        return [];
      }
      const reqId = event.payload.id;
      // 防御：如果 requirement 已被删（孤儿），不产出任何 delta
      if (!getRequirementById(reqId)) {
        // 但要清理可能在 known set 里的该需求相关 ids（虽然此时无法精确知道哪些属于这个 reqId，
        // 因为 known 只存 question id 不存 requirement id；
        // 现实路径：requirement 一旦被删，scan 也不会再加它们；这里靠 known 自然衰减即可）
        return [];
      }
      const all = listQuestionsByRequirement(reqId);
      const deltas: CardDelta[] = [];

      // Adds：当前 open 但 known 没有
      for (const q of all) {
        if (q.status === "open" && !known.has(q.id)) {
          known.add(q.id);
          deltas.push({ op: "add", card: buildCard(q) });
        }
      }
      // Removes：known 中存在但当前已 resolved 的（属于本 requirement）
      for (const q of all) {
        if (q.status !== "open" && known.has(q.id)) {
          known.delete(q.id);
          deltas.push({ op: "remove", id: `open-question:${q.id}`, reason: "resolved" });
        }
      }
      return deltas;
    },
  };
}
