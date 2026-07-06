import { test, expect } from "bun:test";
import { isStandaloneDir } from "../src/core/runtime-env";

test("识别 bun 编译虚拟根", () => {
  expect(isStandaloneDir("B:/~BUN/root")).toBe(true);
  expect(isStandaloneDir("/$bunfs/root")).toBe(true);
  expect(isStandaloneDir("C:\\Users\\larry\\autopilot\\src\\core")).toBe(false);
  expect(isStandaloneDir("/home/user/autopilot/src/core")).toBe(false);
});
