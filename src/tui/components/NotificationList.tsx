import React from "react";
import { Box, Text } from "ink";
import type { Notification, NotificationSeverity } from "../../core/notification-types";
import { notificationIntentToLabel } from "../../client/notification-intent";

const SEVERITY_COLOR: Record<NotificationSeverity, string> = {
  error: "red",
  action: "yellow",
  info: "green",
};

/** 归属上下文行：项目名 · 仓库:分支 */
function contextLine(n: Notification): string | null {
  const ctx = n.context;
  if (!ctx) return null;
  const repo = ctx.workspace_alias
    ? ctx.branch ? `${ctx.workspace_alias}:${ctx.branch}` : ctx.workspace_alias
    : null;
  const parts = [ctx.project_name, repo].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

interface Props {
  items: Notification[];
  loading: boolean;
}

/** observer-only 通知视图：只读最近通知 + 未读标记，决策动作去 Web / CLI */
export function NotificationList({ items, loading }: Props) {
  if (loading && items.length === 0) {
    return (
      <Box padding={1}>
        <Text dimColor>加载中...</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box padding={1} flexDirection="column">
        <Text>🎉 没有通知</Text>
        <Text dimColor>提一个新需求开始：autopilot start "&lt;标题&gt;"</Text>
      </Box>
    );
  }

  const nowMs = Date.now();
  const unread = items.filter((n) => n.read_at === null).length;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>最近 {items.length} 条通知{unread > 0 ? `（${unread} 未读）` : ""}</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((n) => {
          const heading = n.context?.requirement_title || n.body || n.title;
          const ctxLine = contextLine(n);
          const actions = n.actions.map((a) => notificationIntentToLabel(a.intent)).join(" / ");
          return (
            <Box key={n.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={SEVERITY_COLOR[n.severity]} bold>
                  {n.read_at === null ? "● " : "  "}[{n.title}]
                </Text>
                <Text> </Text>
                <Text>{heading}</Text>
                <Text dimColor> · {formatAgo(nowMs - n.created_at)}</Text>
              </Box>
              {ctxLine && (
                <Box marginLeft={4}>
                  <Text dimColor>{ctxLine}</Text>
                </Box>
              )}
              {actions && (
                <Box marginLeft={4}>
                  <Text dimColor>动作: </Text>
                  <Text>{actions}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
