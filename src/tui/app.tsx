import React, { useState } from "react";
import { Box, useInput, useApp } from "ink";
import { useClient } from "./hooks/useClient";
import { useConnection } from "./hooks/useConnection";
import { useTasks } from "./hooks/useTasks";
import { useNotifications } from "./hooks/useNotifications";
import { Header } from "./components/Header";
import { StatusBar } from "./components/StatusBar";
import { TaskList } from "./components/TaskList";
import { TaskDetail } from "./components/TaskDetail";
import { WorkflowList } from "./components/WorkflowList";
import { NotificationList } from "./components/NotificationList";

const TABS = ["通知", "任务", "工作流"];

interface AppProps {
  port: number;
}

export function App({ port }: AppProps) {
  const client = useClient(port);
  const connection = useConnection(client);
  const { tasks, loading: tasksLoading } = useTasks(client);
  const { items: notifications, loading: notificationsLoading } = useNotifications(client);
  const [activeTab, setActiveTab] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();

  useInput((input, key) => {
    // 退出
    if (input === "q") {
      exit();
      return;
    }

    // 切换 Tab
    const tabNum = parseInt(input, 10);
    if (tabNum >= 1 && tabNum <= TABS.length) {
      setActiveTab(tabNum - 1);
      return;
    }

    // 列表导航（仅在 "任务" tab 下生效）
    if (activeTab === 1) {
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelectedIndex((i) => Math.min(tasks.length - 1, i + 1));
      }
    }
  });

  const selectedTask = tasks[selectedIndex] ?? null;

  return (
    <Box flexDirection="column" height="100%">
      <Header activeTab={activeTab} tabs={TABS} />

      <Box flexDirection="column" flexGrow={1}>
        {activeTab === 0 ? (
          <NotificationList items={notifications} loading={notificationsLoading} />
        ) : activeTab === 1 ? (
          <>
            <TaskList tasks={tasks} selectedIndex={selectedIndex} loading={tasksLoading} />
            <TaskDetail task={selectedTask} client={client} />
          </>
        ) : (
          <WorkflowList client={client} />
        )}
      </Box>

      <StatusBar connection={connection} tasks={tasks} port={port} />
    </Box>
  );
}
