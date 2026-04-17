import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { AutopilotClient } from "../../client/index";

interface WorkflowListProps {
  client: AutopilotClient;
}

interface WorkflowInfo {
  name: string;
  description: string;
}

export function WorkflowList({ client }: WorkflowListProps) {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.listWorkflows()
      .then(setWorkflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client]);

  if (loading) {
    return (
      <Box paddingX={1}>
        <Text color="gray">加载中...</Text>
      </Box>
    );
  }

  if (workflows.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">暂无已注册工作流</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        已注册工作流（共 {workflows.length} 个）
      </Text>
      <Text> </Text>
      {workflows.map((wf) => (
        <Box key={wf.name}>
          <Text color="green" bold>
            {"  ▸ "}
          </Text>
          <Text bold>{wf.name}</Text>
          {wf.description && (
            <Text color="gray">{`  — ${wf.description}`}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
