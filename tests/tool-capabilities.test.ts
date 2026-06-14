import { describe, it, expect } from "bun:test";
import {
  expandToApiTools,
  unknownCapabilities,
  isKnownCapability,
  claudeDisallowFor,
  isReadOnlyCaps,
  coarsenCodexSandbox,
  coarsenGeminiApproval,
  CONTROL_CHANNEL_API_TOOLS,
  CLAUDE_GATEABLE_TOOLS,
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

describe("claudeDisallowFor（CLI claude · disallow 补集）", () => {
  it("read+search → 拒掉写/执行/web 类（保留 Read/Grep/Glob）", () => {
    const dis = claudeDisallowFor(["read", "search"]);
    expect(dis).toContain("Write");
    expect(dis).toContain("Edit");
    expect(dis).toContain("Bash");
    expect(dis).toContain("WebFetch");
    expect(dis).toContain("WebSearch");
    expect(dis).toContain("NotebookEdit");
    expect(dis).not.toContain("Read");
    expect(dis).not.toContain("Grep");
    expect(dis).not.toContain("Glob");
  });

  it("授 bash → Bash 不在拒绝列表", () => {
    expect(claudeDisallowFor(["bash"])).not.toContain("Bash");
  });

  it("空授权 → 门禁集全拒", () => {
    expect(claudeDisallowFor([]).sort()).toEqual([...CLAUDE_GATEABLE_TOOLS].sort());
  });

  it("授全部能力 → 一个都不拒", () => {
    const all = ["read", "list", "search", "write", "edit", "delete", "bash", "web_fetch", "web_search"];
    expect(claudeDisallowFor(all)).toEqual([]);
  });

  it("未知能力名不影响（被忽略）", () => {
    const dis = claudeDisallowFor(["read", "telepathy"]);
    expect(dis).toContain("Bash"); // 仍拒
    expect(dis).not.toContain("Read");
  });
});

describe("codex / gemini 粗档回退", () => {
  it("isReadOnlyCaps：含 write/edit/delete/bash 任一 = 非只读", () => {
    expect(isReadOnlyCaps(["read", "search", "list", "web_fetch"])).toBe(true);
    expect(isReadOnlyCaps(["read", "write"])).toBe(false);
    expect(isReadOnlyCaps(["bash"])).toBe(false);
    expect(isReadOnlyCaps(["delete"])).toBe(false);
    expect(isReadOnlyCaps([])).toBe(true);
  });

  it("coarsenCodexSandbox：只读集 → read-only；否则保持配置", () => {
    expect(coarsenCodexSandbox(["read", "search"], "workspace-write")).toBe("read-only");
    expect(coarsenCodexSandbox(["write"], "workspace-write")).toBe("workspace-write");
    // 不放宽：非只读集保持原配置，不会提到 danger-full-access
    expect(coarsenCodexSandbox(["bash"], "workspace-write")).toBe("workspace-write");
  });

  it("coarsenGeminiApproval：只读集 → 强制 default；否则保持配置", () => {
    expect(coarsenGeminiApproval(["read"], "yolo")).toBe("default");
    expect(coarsenGeminiApproval(["write"], "yolo")).toBe("yolo"); // 不擅自收紧已放开的写场景
    expect(coarsenGeminiApproval(["read"], "default")).toBe("default");
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
