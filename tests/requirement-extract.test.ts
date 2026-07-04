import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { runClarifierExtract, _setExtractFnForTest } from "../src/daemon/requirement-extract";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  process.env.DEV_WORKFLOW_CONFIG = join(tmpHome, "config.yaml");
  writeFileSync(
    join(tmpHome, "config.yaml"),
    "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n",
    "utf-8",
  );
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  _setExtractFnForTest(null);
  delete process.env.AUTOPILOT_HOME;
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("runClarifierExtract", () => {
  it("正常返回 title + spec_md", async () => {
    _setExtractFnForTest(async () =>
      JSON.stringify({ title: "登录页忘记密码", spec_md: "## 背景\n用户忘记密码\n## 目标\n邮件重置\n## 验收\n能收到邮件" }),
    );
    const r = await runClarifierExtract({
      raw_text: "给登录页加忘记密码功能",
      project_id: "proj-001",
    });
    expect(r.title).toBe("登录页忘记密码");
    expect(r.spec_md).toContain("## 背景");
  });

  it("```json 围栏块输出也能解析（降级契约格式）", async () => {
    _setExtractFnForTest(async () =>
      "```json\n" + JSON.stringify({ title: "围栏标题", spec_md: "## 背景\n围栏内容" }) + "\n```",
    );
    const r = await runClarifierExtract({
      raw_text: "随便说点啥",
      project_id: "proj-001",
    });
    expect(r.title).toBe("围栏标题");
    expect(r.spec_md).toContain("围栏内容");
  });

  it("LLM 抛错走兜底（title=前30字 spec_md=原文）", async () => {
    _setExtractFnForTest(async () => {
      throw new Error("provider down");
    });
    const r = await runClarifierExtract({
      raw_text: "给登录页加忘记密码功能。需要邮件重置和验证码二选一",
      project_id: "proj-001",
    });
    expect(r.title).toBe("给登录页加忘记密码功能。需要邮件重置和验证码二选一".slice(0, 30));
    expect(r.spec_md).toBe("给登录页加忘记密码功能。需要邮件重置和验证码二选一");
  });

  it("LLM 返回非法 JSON 走兜底", async () => {
    _setExtractFnForTest(async () => "this is not json");
    const r = await runClarifierExtract({
      raw_text: "raw input",
      project_id: "proj-001",
    });
    expect(r.title).toBe("raw input");
    expect(r.spec_md).toBe("raw input");
  });

  it("LLM 返回 JSON 但缺 title 字段走兜底", async () => {
    _setExtractFnForTest(async () => JSON.stringify({ spec_md: "only spec" }));
    const r = await runClarifierExtract({
      raw_text: "fallback case",
      project_id: "proj-001",
    });
    expect(r.title).toBe("fallback case");
    expect(r.spec_md).toBe("fallback case");
  });
});
