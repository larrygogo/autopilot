import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";
import { getTask, listTasks } from "../db";

const AWAIT_REVIEW_STATUS = "running_await_review";

function buildCard(task: { id: string; title: string; created_at: string }): NowCard {
  return {
    id: `await-review:${task.id}`,
    priority: "P1",
    category: "decision",
    title: `Task #${task.id} 等审方案`,
    subtitle: `${task.title} · design 阶段产物已就绪`,
    related: { type: "task", id: task.id },
    actions: [
      { label: "看方案", kind: "primary", href: `/tasks/${task.id}` },
      { label: "驳回", kind: "danger", href: `/tasks/${task.id}?action=reject` },
    ],
    dismissable: false,
    created_at: Math.floor(new Date(task.created_at).getTime() / 1000),
  };
}

export function createAwaitReviewSource(): CardSource {
  return {
    name: "await-review",
    subscribes: ["task:transition"],

    async scan() {
      return listTasks({ status: AWAIT_REVIEW_STATUS }).map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "task:transition") return [];
      const { taskId, from, to } = event.payload;
      if (to === AWAIT_REVIEW_STATUS) {
        const task = getTask(taskId);
        if (!task) return [];
        return [{ op: "add", card: buildCard(task) }];
      }
      if (from === AWAIT_REVIEW_STATUS) {
        return [{ op: "remove", id: `await-review:${taskId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
