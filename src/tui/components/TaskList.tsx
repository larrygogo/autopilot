import React from "react";
import { Box, Text } from "ink";
import type { Task } from "../../core/db";

interface TaskListProps {
  tasks: Task[];
  selectedIndex: number;
  loading: boolean;
}

function statusBadge(status: string): { icon: string; color: string } {
  if (status === "done") return { icon: "✓", color: "green" };
  if (status === "cancelled") return { icon: "✗", color: "red" };
  if (status.startsWith("running_")) return { icon: "●", color: "yellow" };
  if (status.startsWith("pending_")) return { icon: "○", color: "blue" };
  return { icon: "·", color: "gray" };
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function TaskList({ tasks, selectedIndex, loading }: TaskListProps) {
  if (loading) {
    return (
      <Box paddingX={1}>
        <Text color="gray">加载中...</Text>
      </Box>
    );
  }

  if (tasks.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">暂无任务</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="gray" bold>
          {"  ID        标题                 工作流     状态                 时间"}
        </Text>
      </Box>
      {tasks.map((task, i) => {
        const selected = i === selectedIndex;
        const badge = statusBadge(task.status);
        const age = timeAgo(task.updated_at);

        return (
          <Box key={task.id}>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "> " : "  "}
            </Text>
            <Text color={selected ? "cyan" : undefined}>
              {task.id.padEnd(10)}
            </Text>
            <Text color={selected ? "cyan" : "white"}>
              {(task.title ?? "").slice(0, 20).padEnd(21)}
            </Text>
            <Text color="gray">
              {(task.workflow ?? "").padEnd(11)}
            </Text>
            <Text color={badge.color}>
              {badge.icon} {task.status.padEnd(20)}
            </Text>
            <Text color="gray">{age}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
