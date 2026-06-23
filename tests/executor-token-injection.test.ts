import { test, expect } from "bun:test";
import { pickCloneToken } from "../src/core/sandbox/codebase";

test("pickCloneToken: 注入 token 优先于环境解析", () => {
  expect(pickCloneToken("inject-abc")).toBe("inject-abc");
});

test("pickCloneToken: 空白注入视为未注入，回退环境", () => {
  // 空字符串 / 纯空白不算有效注入，应走环境回退（返回环境 token 或 null）
  const resultEmpty = pickCloneToken("");
  const resultWhitespace = pickCloneToken("   ");
  // 核心断言：空白注入不得返回注入值本身（不短路成 "" 或 "   "）
  expect(resultEmpty).not.toBe("");
  expect(resultWhitespace).not.toBe("   ");
  // 两者行为一致（都走同一回退路径）
  expect(resultEmpty).toEqual(resultWhitespace);
});

test("pickCloneToken: 无注入时回退环境（结果类型正确）", () => {
  const result = pickCloneToken(undefined);
  // 不论本机是否有 gh token，返回值只能是 string 或 null
  expect(result === null || typeof result === "string").toBe(true);
});
