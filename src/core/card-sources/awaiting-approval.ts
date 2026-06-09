import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";
import { listRequirements, getRequirementById } from "../requirements";

function buildCard(req: { id: string; title: string; created_at: number }): NowCard {
  return {
    id: `awaiting-approval:${req.id}`,
    priority: "P1",
    category: "decision",
    title: `等审批：${req.title}`,
    subtitle: `需求 ${req.id} 已就绪，等你审批入队`,
    related: { type: "requirement", id: req.id },
    actions: [
      { label: "去看", kind: "primary", href: `/requirements/${req.id}`, intent: { kind: "view_requirement", requirementId: req.id } },
    ],
    dismissable: false,
    created_at: Math.floor(req.created_at / 1000),
  };
}

export function createAwaitingApprovalSource(): CardSource {
  return {
    name: "awaiting-approval",
    subscribes: ["requirement:status-changed"],

    async scan() {
      const reqs = listRequirements({ status: "awaiting_approval" });
      return reqs.map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "requirement:status-changed") return [];
      const { id, from, to } = event.payload;
      if (to === "awaiting_approval") {
        const req = getRequirementById(id);
        if (!req) return [];
        return [{ op: "add", card: buildCard(req) }];
      }
      if (from === "awaiting_approval") {
        return [{ op: "remove", id: `awaiting-approval:${id}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
