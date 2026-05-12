import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { getTask, listTasks } from "../db";
import type { Task } from "../db";

function buildCard(task: Task): NowCard {
  return {
    id: `task-failed:${task.id}`,
    priority: "P0",
    category: "error",
    title: `⚠ Task #${task.id} 失败`,
    subtitle: task.title,
    related: { type: "task", id: task.id },
    actions: [
      { label: "看错误", kind: "primary", href: `/tasks/${task.id}` },
      { label: "关闭", kind: "secondary", invoke: {
        method: "POST",
        path: `/api/now/cards/task-failed:${task.id}/dismiss`,
      } },
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
        return [{ op: "remove", id: `task-failed:${taskId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
