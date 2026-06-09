import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";

function buildCard(taskId: string, phase: string, fromStatus: string, toStatus: string): NowCard {
  return {
    id: `stuck:${taskId}`,
    priority: "P1",
    category: "decision",
    title: `⚠ Task #${taskId} 曾卡死，已自动恢复`,
    subtitle: `${phase} 阶段：${fromStatus} → ${toStatus}（watcher 接管）`,
    related: { type: "task", id: taskId },
    actions: [
      { kind: "primary", intent: { kind: "view_task", taskId: taskId } },
      { kind: "secondary", intent: { kind: "dismiss", cardId: `stuck:${taskId}` } },
    ],
    dismissable: true,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function createStuckSource(): CardSource {
  return {
    name: "stuck",
    subscribes: ["watcher:recovery"],

    async scan() {
      return [];
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "watcher:recovery") return [];
      const { taskId, phase, fromStatus, toStatus } = event.payload;
      return [{ op: "add", card: buildCard(taskId, phase, fromStatus, toStatus) }];
    },
  };
}
