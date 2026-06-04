import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";
import { getDb } from "../db";

function count(sql: string): number {
  const row = getDb().query<{ n: number }, []>(sql).get();
  return row?.n ?? 0;
}

function snapshot(): NowCard[] {
  const projects = count("SELECT COUNT(*) AS n FROM projects");
  if (projects === 0) {
    return [{
      id: "empty-state:no-project",
      priority: "P2",
      category: "decision",
      title: "先建一个项目吧",
      subtitle: "项目是 autopilot 工作的最小单位",
      actions: [
        { label: "新建项目", kind: "primary", href: "/library/projects/new" },
      ],
      dismissable: false,
      created_at: Math.floor(Date.now() / 1000),
    }];
  }

  const workspaces = count("SELECT COUNT(*) AS n FROM workspaces");
  if (workspaces === 0) {
    return [{
      id: "empty-state:no-workspace",
      priority: "P2",
      category: "decision",
      title: "给项目加一个工作区",
      subtitle: "工作区（Workspace）是实际的 Git 目录",
      actions: [
        { label: "去添加", kind: "primary", href: "/library" },
      ],
      dismissable: false,
      created_at: Math.floor(Date.now() / 1000),
    }];
  }

  const requirements = count("SELECT COUNT(*) AS n FROM requirements");
  if (requirements === 0) {
    return [{
      id: "empty-state:no-requirement",
      priority: "P2",
      category: "decision",
      title: "提一个新需求开始",
      subtitle: "autopilot 会调查 → 你审批 → 自动开发 → 提 PR",
      actions: [
        { label: "/start", kind: "primary", href: "/start" },
      ],
      dismissable: false,
      created_at: Math.floor(Date.now() / 1000),
    }];
  }

  return [];
}

export function createEmptyStateSource(): CardSource {
  return {
    name: "empty-state",
    subscribes: ["task:created", "task:transition", "requirement:status-changed"],

    async scan() {
      return snapshot();
    },

    async onEvent(_event: AutopilotEvent): Promise<CardDelta[]> {
      // 简化策略：每次相关事件来时全量重算 empty-state；最多一张卡，开销可忽略。
      // "clear all + re-add"：aggregator 看到不存在 id 的 remove 是 no-op。
      const wanted = snapshot();
      const removeAll: CardDelta[] = [
        { op: "remove", id: "empty-state:no-project", reason: "resolved" },
        { op: "remove", id: "empty-state:no-workspace", reason: "resolved" },
        { op: "remove", id: "empty-state:no-requirement", reason: "resolved" },
      ];
      const adds: CardDelta[] = wanted.map((c) => ({ op: "add", card: c }));
      return [...removeAll, ...adds];
    },
  };
}
