import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";

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
      { label: "查看", kind: "primary", href: `/requirements/${reqId}` },
      {
        label: "重试",
        kind: "secondary",
        invoke: {
          method: "POST",
          path: `/api/requirements/${reqId}/retry-clarify`,
        },
      },
    ],
    dismissable: false,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function createClarifierErrorSource(): CardSource {
  return {
    name: "clarifier-error",
    subscribes: ["requirement:clarifier-error"],

    async scan() {
      return [];
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "requirement:clarifier-error") return [];
      const { id, reason } = event.payload;
      return [{ op: "add", card: buildCard(id, reason) }];
    },
  };
}
