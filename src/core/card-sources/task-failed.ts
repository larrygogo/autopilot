import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";
import { getTask, listTasks } from "../db";
import type { Task } from "../db";
import { contextForTask } from "./context";

function buildCard(task: Task): NowCard {
  return {
    id: `task-failed:${task.id}`,
    priority: "P0",
    category: "error",
    title: `⚠ Task #${task.id} 失败`,
    subtitle: task.title,
    related: { type: "task", id: task.id },
    context: contextForTask(task.id),
    actions: [
      { kind: "primary", intent: { kind: "view_task", taskId: task.id } },
      { kind: "secondary", intent: { kind: "dismiss", cardId: `task-failed:${task.id}` } },
    ],
    dismissable: true,
    created_at: Math.floor(new Date(task.updated_at).getTime() / 1000),
  };
}

export function createTaskFailedSource(): CardSource {
  return {
    name: "task-failed",
    subscribes: ["task:transition"],

    async scan() {
      return listTasks({ status: "failed" }).map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "task:transition") return [];
      const { taskId, from, to } = event.payload;
      if (to === "failed") {
        const task = getTask(taskId);
        if (!task) return [];
        return [{ op: "add", card: buildCard(task) }];
      }
      if (from === "failed") {
        const cardId = `task-failed:${taskId}`;
        return [
          { op: "remove", id: cardId, reason: "resolved" },
          { op: "clear-dismiss", id: cardId },
        ];
      }
      return [];
    },
  };
}
