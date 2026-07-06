import { test, expect } from "bun:test";
import { pickCloneToken } from "../src/core/sandbox/codebase";

test("pickCloneToken: 注入 token 优先于环境解析", () => {
  expect(pickCloneToken("inject-abc")).toBe("inject-abc");
});

test("pickCloneToken: 空白注入视为未注入，走与 undefined 相同的回退路径", () => {
  // 空字符串 / 纯空白不算有效注入，应与无注入完全等价（环境无关）
  const fallback = pickCloneToken(undefined);
  expect(pickCloneToken("")).toEqual(fallback);
  expect(pickCloneToken("   ")).toEqual(fallback);
});

test("pickCloneToken: 无注入时回退环境（结果类型正确）", () => {
  const result = pickCloneToken(undefined);
  // 不论本机是否有 gh token，返回值只能是 string 或 null
  expect(result === null || typeof result === "string").toBe(true);
});
