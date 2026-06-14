import { describe, it, expect } from "bun:test";
import {
  expandToApiTools,
  unknownCapabilities,
  isKnownCapability,
  CONTROL_CHANNEL_API_TOOLS,
} from "../src/agents/tool-capabilities";

describe("expandToApiTools", () => {
  it("能力名展开成对应 API 工具", () => {
    const t = expandToApiTools(["read", "search"]);
    expect(t.has("read_file")).toBe(true);
    expect(t.has("search_files")).toBe(true);
    expect(t.has("write_file")).toBe(false);
    expect(t.has("bash")).toBe(false);
  });

  it("write 展开 write_file + create_directory；delete 展开 delete_file + move_file", () => {
    const t = expandToApiTools(["write", "delete"]);
    expect(t.has("write_file")).toBe(true);
    expect(t.has("create_directory")).toBe(true);
    expect(t.has("delete_file")).toBe(true);
    expect(t.has("move_file")).toBe(true);
  });

  it("控制通道工具（task_complete）永远在集合里——哪怕只授 read", () => {
    expect(expandToApiTools(["read"]).has("task_complete")).toBe(true);
    // 空授权也保留控制通道（纯思考 phase）
    expect(expandToApiTools([]).has("task_complete")).toBe(true);
    for (const c of CONTROL_CHANNEL_API_TOOLS) {
      expect(expandToApiTools([]).has(c)).toBe(true);
    }
  });

  it("web_search 在 API 模式无对应工具（degrade-silent，不抛）", () => {
    const t = expandToApiTools(["web_search", "read"]);
    expect(t.has("read_file")).toBe(true);
    // 只剩 read_file + 控制通道，没有凭空冒出的工具
    expect(t.has("fetch_url")).toBe(false);
  });

  it("未知能力名静默忽略", () => {
    const t = expandToApiTools(["read", "telepathy", "bash"]);
    expect(t.has("read_file")).toBe(true);
    expect(t.has("bash")).toBe(true);
    expect([...t].some((x) => x.includes("telepathy"))).toBe(false);
  });
});

describe("unknownCapabilities / isKnownCapability", () => {
  it("挑出不认识的能力名", () => {
    expect(unknownCapabilities(["read", "fly", "bash", "xyz"])).toEqual(["fly", "xyz"]);
  });
  it("isKnownCapability", () => {
    expect(isKnownCapability("read")).toBe(true);
    expect(isKnownCapability("web_search")).toBe(true);
    expect(isKnownCapability("nope")).toBe(false);
  });
});
