import { describe, it, expect } from "bun:test";
import { findSkippedMigrations } from "../src/core/migrate";

// 回归 #13：撞号护栏只防 file×file。补一个 ≤MAX 的新迁移号（并行分支合并取了已过号）会被
// `version<=current 跳过`逻辑静默略过、永不应用，且不触发撞号断言。findSkippedMigrations 把
// 这种 file×ledger 不一致检出，runPendingMigrations 据此启动期 throw（033 烧伤同源风险根治）。

describe("findSkippedMigrations: file×ledger 一致性", () => {
  it("补一个 ≤MAX 的新迁移号（不在 applied）→ 检出", () => {
    const files = ["001-a.ts", "002-b.ts", "030-new.ts", "045-c.ts"];
    const applied = new Set([1, 2, 45]); // 030 从未应用（新合入的低号）
    expect(findSkippedMigrations(files, 45, applied).map((s) => s.version)).toEqual([30]);
  });

  it("合法空号（003 从无文件）不误报——判据以磁盘实际文件为基准", () => {
    const files = ["001-a.ts", "002-b.ts", "004-d.ts"];
    const applied = new Set([1, 2, 4]);
    expect(findSkippedMigrations(files, 4, applied)).toEqual([]);
  });

  it("全部已应用 → 空", () => {
    expect(findSkippedMigrations(["001-a.ts", "002-b.ts"], 2, new Set([1, 2]))).toEqual([]);
  });

  it("新迁移 > currentVersion（正常 pending）→ 不报（会正常应用）", () => {
    const files = ["001-a.ts", "046-new.ts"];
    expect(findSkippedMigrations(files, 1, new Set([1]))).toEqual([]);
  });

  it("多个被跳过 → 全部检出", () => {
    const files = ["001-a.ts", "010-x.ts", "020-y.ts", "030-z.ts"];
    const applied = new Set([1, 30]); // 010 / 020 都没应用且 ≤30
    expect(findSkippedMigrations(files, 30, applied).map((s) => s.version)).toEqual([10, 20]);
  });
});
