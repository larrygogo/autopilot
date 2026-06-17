import { describe, expect, test } from "bun:test";
import { createLogger, setPhase, resetPhase, localizeLogLine } from "../src/core/logger";

describe("localizeLogLine（行首 UTC → 服务器本地，console / daemon.log 用）", () => {
  test("行首 UTC 时间戳转本地（与同一 Date 的本地分量一致，跨时区确定性）", () => {
    const line = "2026-06-17 06:00:00 [INFO] [SYSTEM] [test] hello %s";
    const t = new Date("2026-06-17T06:00:00Z");
    const p = (n: number) => String(n).padStart(2, "0");
    const expectedTs = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
      `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    expect(localizeLogLine(line)).toBe(`${expectedTs} [INFO] [SYSTEM] [test] hello %s`);
  });

  test("无时间戳行原样返回", () => {
    expect(localizeLogLine("no timestamp here")).toBe("no timestamp here");
  });

  test("非法时间戳原样返回（不抛）", () => {
    expect(localizeLogLine("2026-13-99 99:99:99 [INFO] x")).toBe("2026-13-99 99:99:99 [INFO] x");
  });
});

describe("logger", () => {
  test("createLogger returns logger with all methods", () => {
    const logger = createLogger("test");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  test("setPhase and resetPhase do not throw", () => {
    setPhase("design", "DESIGN");
    resetPhase();
  });
});
