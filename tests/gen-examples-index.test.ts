import { test, expect } from "bun:test";
import { EXAMPLE_TEMPLATES, EXAMPLE_TS_ONLY } from "../src/generated/_examples";

test("dev 与 ad-hoc 模板在常量里、doc 有 phases", () => {
  const names = EXAMPLE_TEMPLATES.map((t) => t.name);
  expect(names).toContain("dev");
  expect(names).toContain("ad-hoc");
  const dev = EXAMPLE_TEMPLATES.find((t) => t.name === "dev")!;
  expect(Array.isArray(dev.doc.phases)).toBe(true);
  expect(dev.revision).toBeGreaterThanOrEqual(0);
});

test("当前无含 ts 模板", () => { expect(EXAMPLE_TS_ONLY).toEqual([]); });
