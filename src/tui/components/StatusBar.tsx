import React from "react";
import { Box, Text } from "ink";
import type { ConnectionState } from "../../client/ws";
import type { Task } from "../../core/db";

interface StatusBarProps {
  connection: ConnectionState;
  tasks: Task[];
  port: number;
}

export function StatusBar({ connection, tasks, port }: StatusBarProps) {
  const statusIcon = connection === "connected" ? "●" : connection === "connecting" ? "◌" : "○";
  const statusColor = connection === "connected" ? "green" : connection === "connecting" ? "yellow" : "red";
  const statusText = connection === "connected" ? "已连接" : connection === "connecting" ? "连接中" : "未连接";

  const running = tasks.filter((t) => t.status.startsWith("running_")).length;
  const total = tasks.length;

  return (
    <Box borderStyle="single" borderTop paddingX={1}>
      <Text color={statusColor}>
        {statusIcon} {statusText}
      </Text>
      <Text color="gray"> │ </Text>
      <Text>
        {total} 任务
      </Text>
      {running > 0 && (
        <>
          <Text color="gray"> │ </Text>
          <Text color="yellow">{running} 运行中</Text>
        </>
      )}
      <Box flexGrow={1} />
      <Text color="gray">Port: {port}</Text>
    </Box>
  );
}
