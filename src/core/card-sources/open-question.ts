import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { listQuestionsByRequirement } from "../requirement-questions";
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
  return getDb().query<
    { id: string; requirement_id: string; agent_text: string; created_at: number },
    []
  >(
    "SELECT id, requirement_id, agent_text, created_at FROM requirement_questions WHERE status = 'open'"
  ).all();
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
