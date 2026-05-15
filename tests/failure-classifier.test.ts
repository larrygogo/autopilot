import { describe, it, expect } from "bun:test";
import { classifyFailure } from "../src/web/src/lib/failure-classifier";

describe("classifyFailure", () => {
  it("空原因 → unknown", () => {
    expect(classifyFailure(null).kind).toBe("unknown");
    expect(classifyFailure("").kind).toBe("unknown");
    expect(classifyFailure("   ").kind).toBe("unknown");
  });

  it("401 / 403 / token 类 → credential", () => {
    expect(classifyFailure("HTTP 401 Unauthorized").kind).toBe("credential");
    expect(classifyFailure("403 forbidden").kind).toBe("credential");
    expect(classifyFailure("Invalid API key").kind).toBe("credential");
    expect(classifyFailure("invalid_api_key").kind).toBe("credential");
    expect(classifyFailure("Authentication failed").kind).toBe("credential");
  });

  it("timeout / connection 类 → network", () => {
    expect(classifyFailure("Request timeout after 30s").kind).toBe("network");
    expect(classifyFailure("ETIMEDOUT").kind).toBe("network");
    expect(classifyFailure("ECONNRESET").kind).toBe("network");
    expect(classifyFailure("fetch failed").kind).toBe("network");
    expect(classifyFailure("ENOTFOUND api.anthropic.com").kind).toBe("network");
  });

  it("JSON / parse / schema 类 → prompt", () => {
    expect(classifyFailure("Invalid JSON output from agent").kind).toBe("prompt");
    expect(classifyFailure("Cannot parse response").kind).toBe("prompt");
    expect(classifyFailure("Missing field: title").kind).toBe("prompt");
    expect(classifyFailure("Schema validation failed").kind).toBe("prompt");
  });

  it("exit code / exception 类 → phase_crash", () => {
    expect(classifyFailure("Phase exited with code 1").kind).toBe("phase_crash");
    expect(classifyFailure("TypeError: Cannot read property 'x' of undefined").kind).toBe("phase_crash");
    expect(classifyFailure("Process killed (SIGKILL)").kind).toBe("phase_crash");
  });

  it("无法匹配的随机文本 → unknown", () => {
    expect(classifyFailure("some weird thing happened").kind).toBe("unknown");
    expect(classifyFailure("error").kind).toBe("unknown");
  });

  it("每个画像都有 hint 和 primary 推荐操作", () => {
    const probes: Record<string, string> = {
      credential: "401 unauthorized",
      network: "ETIMEDOUT",
      prompt: "Invalid JSON",
      phase_crash: "exit code 1",
      unknown: "",
    };
    for (const [kind, probe] of Object.entries(probes)) {
      const profile = classifyFailure(probe);
      expect(profile.kind).toBe(kind as typeof profile.kind);
      expect(profile.hint.length).toBeGreaterThan(10);
      expect(profile.label.length).toBeGreaterThan(0);
      expect(["retry", "fix_prompt", "check_config", "view_logs"]).toContain(profile.primary);
    }
  });
});
