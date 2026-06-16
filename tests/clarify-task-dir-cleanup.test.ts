/**
 * rank27：非 Anthropic 澄清路径用伪 taskId=clarify-<reqId> 落 runtime/tasks/clarify-<reqId>/，
 * 该目录不在需求树下，需终态 / 删除需求时级联清。验证 deleteClarifyTaskDir + deleteRequirementRuntimeDir 兜底。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { deleteClarifyTaskDir, tasksRootDir } from "../src/core/sandbox";
import { deleteRequirementRuntimeDir } from "../src/core/requirements/clone";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-clarifydir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  prevHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
  else process.env.AUTOPILOT_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedClarifyDir(reqId: string): string {
  const dir = join(tasksRootDir(), `clarify-${reqId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-calls.jsonl"), "{}\n");
  return dir;
}

describe("rank27 澄清占位任务目录清理", () => {
  it("deleteClarifyTaskDir 删 runtime/tasks/clarify-<reqId>/；不存在时 no-op 不抛", () => {
    const dir = seedClarifyDir("req-001");
    expect(existsSync(dir)).toBe(true);
    deleteClarifyTaskDir("req-001");
    expect(existsSync(dir)).toBe(false);
    expect(() => deleteClarifyTaskDir("req-001")).not.toThrow(); // 再删（不存在）不抛
  });

  it("deleteRequirementRuntimeDir 兜底级联删 clarify 目录（即便需求树本身不存在）", () => {
    const dir = seedClarifyDir("req-002");
    deleteRequirementRuntimeDir("req-002");
    expect(existsSync(dir)).toBe(false);
  });

  it("只删本 reqId 的目录，不误伤兄弟", () => {
    const d1 = seedClarifyDir("req-100");
    const d2 = seedClarifyDir("req-200");
    deleteClarifyTaskDir("req-100");
    expect(existsSync(d1)).toBe(false);
    expect(existsSync(d2)).toBe(true); // 兄弟不动
  });
});
