import React from "react";
import { Box, Text } from "ink";
import type { NowCard, NowCardPriority } from "../../core/now-types";
import { intentToLabel } from "../../client/now-intent";

const PRIORITY_COLOR: Record<NowCardPriority, string> = {
  P0: "red",
  P1: "yellow",
  P2: "green",
  P3: "gray",
};

const PRIORITY_LABEL: Record<NowCardPriority, string> = {
  P0: "异常",
  P1: "决策",
  P2: "进行",
  P3: "完成",
};

function formatWaited(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}min`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}min` : ""}`;
}

interface Props {
  cards: NowCard[];
  loading: boolean;
}

export function NowList({ cards, loading }: Props) {
  if (loading && cards.length === 0) {
    return (
      <Box padding={1}>
        <Text dimColor>加载中...</Text>
      </Box>
    );
  }

  if (cards.length === 0) {
    return (
      <Box padding={1} flexDirection="column">
        <Text>🎉 没有需要关注的事</Text>
        <Text dimColor>提一个新需求开始：autopilot start "&lt;标题&gt;"</Text>
      </Box>
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>共 {cards.length} 件事需要关注</Text>
      <Box flexDirection="column" marginTop={1}>
        {cards.map((card) => {
          const waited = formatWaited(Math.max(0, nowSec - card.created_at));
          const actions = card.actions.map((a) => intentToLabel(a.intent)).join(" / ");
          return (
            <Box key={card.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={PRIORITY_COLOR[card.priority]} bold>
                  [{card.priority} {PRIORITY_LABEL[card.priority]}]
                </Text>
                <Text> </Text>
                <Text>{card.title}</Text>
                <Text dimColor> · {waited}</Text>
              </Box>
              <Box marginLeft={2}>
                <Text dimColor>{card.subtitle}</Text>
              </Box>
              {actions && (
                <Box marginLeft={2}>
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
