import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { getDb } from "../db";

interface ActiveQuestionRow {
  req_id: string;
  req_title: string;
  q_id: string;
  agent_text: string;
  created_at: number;
}

function listActiveQuestions(): ActiveQuestionRow[] {
  return getDb().query<ActiveQuestionRow, []>(`
    SELECT r.id AS req_id, r.title AS req_title,
           q.id AS q_id, q.agent_text, q.created_at
    FROM requirements r
    INNER JOIN requirement_questions q ON q.id = r.active_question_id
    WHERE q.status = 'open' AND r.status = 'clarifying'
  `).all();
}

function listActiveQuestionForReq(reqId: string): ActiveQuestionRow | null {
  const row = getDb().query<ActiveQuestionRow, [string]>(`
    SELECT r.id AS req_id, r.title AS req_title,
           q.id AS q_id, q.agent_text, q.created_at
    FROM requirements r
    INNER JOIN requirement_questions q ON q.id = r.active_question_id
    WHERE r.id = ? AND q.status = 'open' AND r.status = 'clarifying'
  `).get(reqId);
  return row ?? null;
}

function buildCard(row: ActiveQuestionRow): NowCard {
  const preview = row.agent_text.length > 100
    ? row.agent_text.slice(0, 100) + "…"
    : row.agent_text;
  return {
    id: `open-question:${row.req_id}`,
    priority: "P1",
    category: "decision",
    title: "AI 提了个问题",
    subtitle: `Req ${row.req_id}「${row.req_title}」· ${preview}`,
    related: { type: "requirement", id: row.req_id },
    actions: [
      { label: "回答", kind: "primary", href: `/requirements/${row.req_id}` },
    ],
    dismissable: false,
    created_at: Math.floor(row.created_at / 1000),
  };
}

export function createOpenQuestionSource(): CardSource {
  return {
    name: "open-question",
    subscribes: [
      "requirement:active-question-changed",
      "requirement:status-changed",
    ],

    async scan() {
      return listActiveQuestions().map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type === "requirement:active-question-changed") {
        const { id: reqId, question_id } = event.payload;
        if (question_id === null) {
          return [{ op: "remove", id: `open-question:${reqId}`, reason: "resolved" }];
        }
        const row = listActiveQuestionForReq(reqId);
        if (!row) return [];
        return [{ op: "add", card: buildCard(row) }];
      }

      if (event.type === "requirement:status-changed") {
        const { id: reqId, to } = event.payload;
        if (to !== "clarifying") {
          return [{ op: "remove", id: `open-question:${reqId}`, reason: "resolved" }];
        }
        return [];
      }

      return [];
    },
  };
}
