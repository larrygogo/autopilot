// 流水线列表的时间工具：相对时间 + 时段分桶。从 Tasks.tsx 抽出供项目页复用。

export type TimeBucket = "today" | "yesterday" | "week" | "month" | "earlier";
export const BUCKET_ORDER: TimeBucket[] = ["today", "yesterday", "week", "month", "earlier"];
export const BUCKET_LABEL: Record<TimeBucket, string> = {
  today: "今天", yesterday: "昨天", week: "一周内", month: "一月内", earlier: "更早",
};

/** 相对时间（中文）：刚刚 / N分钟前 / N小时前 / N天前 / N周前 / N个月前 */
export function relTime(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}天前`;
  const w = Math.floor(day / 7);
  if (w < 5) return `${w}周前`;
  return `${Math.floor(day / 30)}个月前`;
}

/** 归一化到 ms：需求的 ts 是数字 epoch，任务的是 ISO 字符串；秒级时间戳自动 *1000 */
export function tsToMs(ts: string | number | null | undefined): number {
  if (ts == null) return 0;
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(n)) return 0;
  return n < 1e12 ? n * 1000 : n;
}

export function bucketOf(ms: number, now: number): TimeBucket {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startToday = start.getTime();
  const DAY = 86_400_000;
  if (ms >= startToday) return "today";
  if (ms >= startToday - DAY) return "yesterday";
  if (ms >= startToday - 6 * DAY) return "week";
  if (ms >= startToday - 29 * DAY) return "month";
  return "earlier";
}
