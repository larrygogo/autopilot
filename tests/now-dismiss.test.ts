import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate011 } from "../src/migrations/011-now-dismissed-cards";
import { _setDbForTest } from "../src/core/db";
import { dismissCard, isCardDismissed, clearDismissedCard, listDismissedCardIds } from "../src/core/now-dismiss";

describe("now-dismiss", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    migrate011(db);
    _setDbForTest(db);
  });

  it("dismissCard 后 isCardDismissed 返回 true", () => {
    expect(isCardDismissed("completed:task-5")).toBe(false);
    dismissCard("completed:task-5");
    expect(isCardDismissed("completed:task-5")).toBe(true);
  });

  it("clearDismissedCard 撤销 dismiss", () => {
    dismissCard("task-failed:task-7");
    expect(isCardDismissed("task-failed:task-7")).toBe(true);
    clearDismissedCard("task-failed:task-7");
    expect(isCardDismissed("task-failed:task-7")).toBe(false);
  });

  it("重复 dismiss 同一 card_id 是幂等", () => {
    dismissCard("completed:task-5");
    dismissCard("completed:task-5"); // 不抛
    const ids = listDismissedCardIds();
    expect(ids.filter(id => id === "completed:task-5").length).toBe(1);
  });

  it("listDismissedCardIds 返回全部已 dismiss", () => {
    dismissCard("a");
    dismissCard("b");
    const ids = listDismissedCardIds();
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});
