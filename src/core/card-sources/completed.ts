import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";
import { getTask, getDb } from "../db";
import type { Task } from "../db";

const TWENTY_FOUR_HOURS_MS = 24 * 3600_000;

function buildCard(task: Task): NowCard {
  return {
    id: `completed:${task.id}`,
    priority: "P3",
    category: "completed",
    title: `✓ Task #${task.id} 已完成`,
    subtitle: task.title,
    related: { type: "task", id: task.id },
    actions: [
      { label: "看 PR", kind: "secondary", href: `/tasks/${task.id}`, intent: { kind: "view_task", taskId: task.id } },
      { label: "关闭", kind: "secondary", invoke: {
        method: "POST",
        path: `/api/now/cards/completed:${task.id}/dismiss`,
      }, intent: { kind: "dismiss", cardId: `completed:${task.id}` } },
    ],
    dismissable: true,
    created_at: Math.floor(new Date(task.updated_at).getTime() / 1000),
  };
}

function listRecentlyDone(): Task[] {
  const cutoff = new Date(Date.now() - TWENTY_FOUR_HOURS_MS).toISOString();
  return getDb().query<Task, [string]>(
    "SELECT * FROM tasks WHERE status = 'done' AND updated_at >= ?"
  ).all(cutoff);
}

export function createCompletedSource(): CardSource {
  return {
    name: "completed",
    subscribes: ["task:transition"],

    async scan() {
      return listRecentlyDone().map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "task:transition") return [];
      const { taskId, from, to } = event.payload;
      if (to === "done") {
        const task = getTask(taskId);
        if (!task) return [];
        return [{ op: "add", card: buildCard(task) }];
      }
      if (from === "done") {
        return [{ op: "remove", id: `completed:${taskId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
