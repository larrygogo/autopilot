import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  activeTab: number;
  tabs: string[];
}

export function Header({ activeTab, tabs }: HeaderProps) {
  return (
    <Box borderStyle="single" borderBottom paddingX={1}>
      <Text color="cyan" bold>
        ◆ AUTOPILOT
      </Text>
      <Text> </Text>
      {tabs.map((tab, i) => (
        <React.Fragment key={tab}>
          <Text color={i === activeTab ? "cyan" : "gray"} bold={i === activeTab}>
            {`[${i + 1}] ${tab}`}
          </Text>
          {i < tabs.length - 1 && <Text color="gray"> │ </Text>}
        </React.Fragment>
      ))}
      <Box flexGrow={1} />
      <Text color="gray">q:退出 1-{tabs.length}:切换</Text>
    </Box>
  );
}
