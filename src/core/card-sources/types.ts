/**
 * CardSource 抽象 —— /now 卡片流的插件接口。
 *
 * 从 `now-types.ts` 拆出，避免 `now-types`（纯数据类型）反向 import 事件
 * 类型形成循环。NowCard 等数据类型留在 `now-types.ts`。
 */

import type { AutopilotEvent } from "../events";
import type { NowCard } from "../now-types";

export type CardDelta =
  | { op: "add"; card: NowCard }
  | { op: "update"; id: string; patch: Partial<NowCard> }
  | { op: "remove"; id: string; reason: "resolved" | "dismissed" }
  | { op: "clear-dismiss"; id: string };

export interface CardSource {
  /** 唯一名，作为卡片 id 前缀，例 "completed"、"task-failed" */
  name: string;
  /** 订阅的 event-bus 事件类型；空数组表示纯 scan-only */
  subscribes: string[];
  /** 启动时全扫，返回当前应该展示的所有卡 */
  scan(): Promise<NowCard[]>;
  /** 事件来时计算增量。若与本 source 无关返回 [] */
  onEvent(event: AutopilotEvent): Promise<CardDelta[]>;
}
