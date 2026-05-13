import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";
import { getTask, getDb } from "../db";
import type { Task } from "../db";

const AWAIT_REVIEW_STATUS = "running_await_review";

function phaseOf(status: string): string {
  return status.startsWith("running_") ? status.slice("running_".length) : status;
}

function buildCard(task: Task): NowCard {
  return {
    id: `running:${task.id}`,
    priority: "P2",
    category: "running",
    title: `Task #${task.id} 进行中`,
    subtitle: `${task.title} · ${phaseOf(task.status)} 阶段`,
    related: { type: "task", id: task.id },
    actions: [
      { label: "看日志", kind: "secondary", href: `/tasks/${task.id}` },
    ],
    dismissable: false,
    created_at: Math.floor(new Date(task.created_at).getTime() / 1000),
  };
}

function listRunningExceptAwaitReview(): Task[] {
  return getDb().query<Task, []>(
    "SELECT * FROM tasks WHERE status LIKE 'running_%' AND status != 'running_await_review'"
  ).all();
}

export function createRunningSource(): CardSource {
  return {
    name: "running",
    subscribes: ["task:transition"],

    async scan() {
      return listRunningExceptAwaitReview().map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "task:transition") return [];
      const { taskId, from, to } = event.payload;
      const toRunning = to.startsWith("running_") && to !== AWAIT_REVIEW_STATUS;
      const fromRunning = from.startsWith("running_") && from !== AWAIT_REVIEW_STATUS;

      if (toRunning) {
        const task = getTask(taskId);
        if (!task) return [];
        return [{ op: "add", card: buildCard(task) }];
      }
      if (fromRunning && !toRunning) {
        return [{ op: "remove", id: `running:${taskId}`, reason: "resolved" }];
      }
      return [];
    },
  };
}
