import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";
import { getDb } from "../db";

function buildCard(reqId: string, reason: string): NowCard {
  const preview = reason.length > 80 ? reason.slice(0, 80) + "…" : reason;
  return {
    id: `clarifier-error:${reqId}`,
    priority: "P0",
    category: "error",
    title: `⚠ Req ${reqId} 澄清出错`,
    subtitle: preview,
    related: { type: "requirement", id: reqId },
    actions: [
      { kind: "primary", intent: { kind: "view_requirement", requirementId: reqId } },
      { kind: "secondary", intent: { kind: "retry_clarify", requirementId: reqId } },
    ],
    dismissable: false,
    created_at: Math.floor(Date.now() / 1000),
  };
}

interface ErrorRow { id: string; clarifier_error: string }

export function createClarifierErrorSource(): CardSource {
  return {
    name: "clarifier-error",
    subscribes: [
      "requirement:clarifier-error",
      "requirement:spec-revised",
      "requirement:active-question-changed",
      "requirement:status-changed",
    ],

    async scan() {
      const rows = getDb().query<ErrorRow, []>(
        "SELECT id, clarifier_error FROM requirements WHERE clarifier_error IS NOT NULL"
      ).all();
      return rows.map(r => buildCard(r.id, r.clarifier_error));
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type === "requirement:clarifier-error") {
        const { id, reason } = event.payload;
        return [{ op: "add", card: buildCard(id, reason) }];
      }
      // 任何 clarifier 成功的进展 → 移除该 req 的错误卡
      if (event.type === "requirement:spec-revised"
          || event.type === "requirement:active-question-changed"
          || event.type === "requirement:status-changed") {
        const reqId = event.payload.id;
        return [{ op: "remove", id: `clarifier-error:${reqId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
