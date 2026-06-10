/**
 * 流水线时间工具纯函数测试（从 Tasks.tsx 抽到 lib/pipeline-time 时建立基线）。
 */
import { describe, it, expect } from "bun:test";
import { relTime, tsToMs, bucketOf, BUCKET_ORDER, BUCKET_LABEL } from "../src/web/src/lib/pipeline-time";

const NOW = new Date("2026-06-10T15:00:00+08:00").getTime();

describe("tsToMs", () => {
  it("ISO 字符串转 ms", () => {
    expect(tsToMs("2026-06-10T10:00:00.000Z")).toBe(Date.parse("2026-06-10T10:00:00.000Z"));
  });
  it("秒级 epoch 自动 ×1000", () => {
    expect(tsToMs(1_780_000_000)).toBe(1_780_000_000_000);
  });
  it("ms 级 epoch 原样", () => {
    expect(tsToMs(1_780_000_000_000)).toBe(1_780_000_000_000);
  });
  it("null/undefined/非法 → 0", () => {
    expect(tsToMs(null)).toBe(0);
    expect(tsToMs(undefined)).toBe(0);
    expect(tsToMs("not-a-date")).toBe(0);
  });
});

describe("bucketOf", () => {
  it("今天零点之后 → today", () => {
    const t = new Date(NOW);
    t.setHours(1, 0, 0, 0);
    expect(bucketOf(t.getTime(), NOW)).toBe("today");
  });
  it("昨天 → yesterday", () => {
    expect(bucketOf(NOW - 86_400_000, NOW)).toBe("yesterday");
  });
  it("6 天前 → week，7 天前 → month", () => {
    const startToday = new Date(NOW);
    startToday.setHours(0, 0, 0, 0);
    expect(bucketOf(startToday.getTime() - 6 * 86_400_000 + 1, NOW)).toBe("week");
    expect(bucketOf(startToday.getTime() - 7 * 86_400_000, NOW)).toBe("month");
  });
  it("30 天前 → earlier", () => {
    const startToday = new Date(NOW);
    startToday.setHours(0, 0, 0, 0);
    expect(bucketOf(startToday.getTime() - 30 * 86_400_000, NOW)).toBe("earlier");
  });
});

describe("relTime", () => {
  it("1 分钟内 → 刚刚", () => expect(relTime(NOW - 30_000, NOW)).toBe("刚刚"));
  it("分钟 / 小时 / 天", () => {
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe("5分钟前");
    expect(relTime(NOW - 3 * 3600_000, NOW)).toBe("3小时前");
    expect(relTime(NOW - 2 * 86_400_000, NOW)).toBe("2天前");
  });
});

describe("常量", () => {
  it("BUCKET_ORDER 覆盖 5 桶且 LABEL 齐全", () => {
    expect(BUCKET_ORDER).toEqual(["today", "yesterday", "week", "month", "earlier"]);
    for (const b of BUCKET_ORDER) expect(BUCKET_LABEL[b]).toBeTruthy();
  });
});
