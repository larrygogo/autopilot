import { test, expect } from "bun:test";
import { decodeSafe } from "../src/daemon/routes";

test("decodeSafe 归一与拒绝", () => {
  // 正常路径原样返回（带前导斜杠）
  expect(decodeSafe("/assets/x.js")).toBe("/assets/x.js");

  // 多前导斜杠归一成单 /
  expect(decodeSafe("///assets/x.js")).toBe("/assets/x.js");

  // 含 NUL 字符 → null（安全拒绝）
  expect(decodeSafe("/%00")).toBe(null);

  // URL 编码的普通路径 → 解码后归一
  expect(decodeSafe("/assets/my%20file.js")).toBe("/assets/my file.js");

  // 反斜杠前导归一
  expect(decodeSafe("\\\\assets\\x.js")).toBe("/assets\\x.js");

  // 非法 URL 编码 → null
  expect(decodeSafe("/%")).toBe(null);
  expect(decodeSafe("/%xy")).toBe(null);
});
