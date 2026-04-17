import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { Task } from "../../core/db";
import type { AutopilotClient, AutopilotEvent } from "../../client/index";

interface TaskDetailProps {
  task: Task | null;
  client: AutopilotClient;
}

export function TaskDetail({ task, client }: TaskDetailProps) {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    if (!task) {
      setLogs([]);
      return;
    }

    // 清空日志并订阅新任务
    setLogs([]);

    const unsub = client.subscribe(`log:${task.id}`, (event: AutopilotEvent) => {
      if (event.type === "log:entry") {
        setLogs((prev) => [...prev.slice(-50), event.payload.message]);
      }
    });

    return unsub;
  }, [task?.id, client]);

  if (!task) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color="gray">选择一个任务查看详情</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" borderBottom paddingX={1}>
        <Text bold>任务详情: </Text>
        <Text color="cyan">{task.id}</Text>
        <Text color="gray"> │ </Text>
        <Text>{task.title}</Text>
        <Text color="gray"> │ </Text>
        <Text color="blue">{task.workflow}</Text>
        <Text color="gray"> │ </Text>
        <Text color="yellow">{task.status}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {logs.length === 0 ? (
          <Text color="gray">等待日志...</Text>
        ) : (
          logs.map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
