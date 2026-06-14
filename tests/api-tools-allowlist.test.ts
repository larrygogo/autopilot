/**
 * API 模式工具授权白名单（细粒度 tools 第一刀）：
 * getToolDefinitions / ToolExecutor 按 phase 的 tools 能力集收窄 + _dispatch 拒未授权 + 控制通道豁免 + 缺省全集兼容。
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getToolDefinitions, ToolExecutor } from "../src/agents/providers/api/tools";
import { expandToApiTools } from "../src/agents/tool-capabilities";

const sandbox = mkdtempSync(join(tmpdir(), "autopilot-toolallow-"));

describe("getToolDefinitions 白名单过滤", () => {
  it("不传 allowedApiTools → 全集（兼容现状，default 模式含 bash）", () => {
    const names = getToolDefinitions("default").map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("bash");
    expect(names).toContain("task_complete");
  });

  it("传 [read,search] → 只剩 read_file/search_files + 控制通道 task_complete", () => {
    const allowed = expandToApiTools(["read", "search"]);
    const names = getToolDefinitions("default", allowed).map((t) => t.name);
    expect(names.sort()).toEqual(["read_file", "search_files", "task_complete"].sort());
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
  });

  it("空授权 [] → 只剩控制通道 task_complete（纯思考 phase）", () => {
    const names = getToolDefinitions("default", expandToApiTools([])).map((t) => t.name);
    expect(names).toEqual(["task_complete"]);
  });

  it("授权与 permission_mode 正交：cautious 即便授 bash 也无 bash（cautious 砍 bash）", () => {
    const names = getToolDefinitions("cautious", expandToApiTools(["bash", "read"])).map((t) => t.name);
    expect(names).not.toContain("bash"); // cautious 基础集已无 bash
    expect(names).toContain("read_file");
  });
});

describe("ToolExecutor 授权执行", () => {
  it("fromConfig 带 toolCaps → 未授权工具被 _dispatch 拒（read 授权下调 write_file）", async () => {
    const exec = ToolExecutor.fromConfig(sandbox, "default", ["read"]);
    const r = await exec.execute({ name: "write_file", input: { path: "x.txt", content: "hi" } });
    expect(r.is_error).toBe(true);
    expect(r.output).toContain("未授权");
  });

  it("fromConfig 不带 toolCaps → 不限（write_file 可执行）", async () => {
    const exec = ToolExecutor.fromConfig(sandbox, "default");
    const r = await exec.execute({ name: "write_file", input: { path: "ok.txt", content: "hi" } });
    expect(r.is_error).toBe(false);
  });

  it("授权集内工具正常执行（read 授权下 list_directory 也在？否——list 未授权应被拒）", async () => {
    const exec = ToolExecutor.fromConfig(sandbox, "default", ["read"]);
    const r = await exec.execute({ name: "list_directory", input: { path: "." } });
    expect(r.is_error).toBe(true); // list 能力未授权
  });
});
