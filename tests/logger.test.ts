import { describe, expect, test } from "bun:test";
import { createLogger, setPhase, resetPhase } from "../src/core/logger";

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
