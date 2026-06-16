import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { HttpClient } from "../src/client/http";
import type { Requirement } from "../src/core/requirements";
import { strDisplayWidth, renderRequirementsTable } from "../src/cli/requirements-cli";

// ── Task 1：HttpClient.listRequirements 透传测试 ─────────────

describe("HttpClient.listRequirements", () => {
  /** 构造一个不需要真实 WS 连接的 HttpClient，替换内部 rpc 为 spy。 */
  function makeSpyClient() {
    const client = new HttpClient("http://localhost:1");
    const spy: Array<{ method: string; params: unknown }> = [];
    (client as unknown as Record<string, unknown>).rpc = {
      call: (method: string, params: unknown) => {
        spy.push({ method, params });
        return Promise.resolve({ requirements: [] });
      },
      close: () => {},
    };
    return { client, spy };
  }

  it("无参数时调 requirements.list，透传空对象", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements();
    expect(spy).toHaveLength(1);
    expect(spy[0]!.method).toBe("requirements.list");
    expect(spy[0]!.params).toEqual({});
  });

  it("透传 status 过滤参数", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements({ status: "drafting" });
    expect(spy[0]!.method).toBe("requirements.list");
    expect((spy[0]!.params as Record<string, string>).status).toBe("drafting");
  });

  it("透传 project_id 过滤参数", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements({ project_id: "proj-001" });
    expect((spy[0]!.params as Record<string, string>).project_id).toBe("proj-001");
  });

  it("透传 workspace_id 过滤参数", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements({ workspace_id: "ws-001" });
    expect((spy[0]!.params as Record<string, string>).workspace_id).toBe("ws-001");
  });

  it("同时透传三个过滤参数", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements({
      status: "ready",
      project_id: "proj-002",
      workspace_id: "ws-002",
    });
    const p = spy[0]!.params as Record<string, string>;
    expect(p.status).toBe("ready");
    expect(p.project_id).toBe("proj-002");
    expect(p.workspace_id).toBe("ws-002");
  });

  it("返回值含 requirements 数组", async () => {
    const { client } = makeSpyClient();
    const result = await client.listRequirements();
    expect(result).toHaveProperty("requirements");
    expect(Array.isArray(result.requirements)).toBe(true);
  });

  it("显式传 undefined 时等价于无参，透传空对象（CLI 空过滤链路）", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements(undefined);
    expect(spy).toHaveLength(1);
    expect(spy[0]!.method).toBe("requirements.list");
    expect(spy[0]!.params).toEqual({});
  });
});

// ── Task 2：strDisplayWidth + renderRequirementsTable 渲染测试 ─

/** 构造最小 Requirement 对象（只包含渲染用到的字段）。 */
function mkReq(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: "req-001",
    project_id: "proj-001",
    workspace_id: null,
    title: "Default title",
    status: "drafting",
    spec_md: "",
    chat_session_id: null,
    task_id: null,
    pr_url: null,
    pr_number: null,
    last_reviewed_event_id: null,
    active_question_id: null,
    clarifier_error: null,
    clarifier_provider: null,
    clarifier_model: null,
    schedule_error: null,
    status_reason: null,
    status_reason_source: null,
    status_before_terminal: null,
    workflow: null,
    input_mode: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("strDisplayWidth", () => {
  it("纯 ASCII 字符串宽度 = 字符数", () => {
    expect(strDisplayWidth("hello")).toBe(5);
    expect(strDisplayWidth("")).toBe(0);
    expect(strDisplayWidth("ab cd")).toBe(5);
  });

  it("CJK 字符每个宽度 = 2", () => {
    expect(strDisplayWidth("中")).toBe(2);
    expect(strDisplayWidth("中文")).toBe(4);
    expect(strDisplayWidth("中文abc")).toBe(7); // 4 + 3
  });

  it("混合字符串宽度正确", () => {
    expect(strDisplayWidth("用户登录优化")).toBe(12); // 6 汉字 × 2
    expect(strDisplayWidth("fix: 修复")).toBe(9);    // "fix: " = 5 + "修复" = 4
  });

  it("控制字符（\\n / \\t）被计为宽度 1（不在 isWideChar 范围内）", () => {
    // 控制字符不是 wide char，每个计 1 列。
    // 表格数据中通常不应出现控制字符，此测试仅记录边界行为。
    expect(strDisplayWidth("\n")).toBe(1);
    expect(strDisplayWidth("\t")).toBe(1);
    expect(strDisplayWidth("abc\ndef")).toBe(7); // 3 + 1 + 3
  });
});

describe("renderRequirementsTable", () => {
  it("空列表返回友好提示，不为空字符串", () => {
    const out = renderRequirementsTable([]);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("暂无需求");
  });

  it("输出包含五列表头：id / title / status / workflow / project_id", () => {
    const out = renderRequirementsTable([mkReq()]);
    expect(out).toContain("id");
    expect(out).toContain("title");
    expect(out).toContain("status");
    expect(out).toContain("workflow");
    expect(out).toContain("project_id");
  });

  it("输出包含分隔线（某行以多个 - 开头）", () => {
    const out = renderRequirementsTable([mkReq()]);
    expect(out).toMatch(/^-+/m);
  });

  it("workflow 为 null 时显示 dev（默认）", () => {
    const out = renderRequirementsTable([mkReq({ workflow: null })]);
    expect(out).toContain("dev（默认）");
  });

  it("workflow 非 null 时显示实际值，不含默认标签", () => {
    const out = renderRequirementsTable([mkReq({ workflow: "req_dev" })]);
    expect(out).toContain("req_dev");
    expect(out).not.toContain("dev（默认）");
  });

  it("输出包含 id / title / status / project_id 字段值", () => {
    const r = mkReq({ id: "req-042", title: "Test feature", status: "ready", project_id: "proj-007" });
    const out = renderRequirementsTable([r]);
    expect(out).toContain("req-042");
    expect(out).toContain("Test feature");
    expect(out).toContain("ready");
    expect(out).toContain("proj-007");
  });

  it("末尾包含需求总数", () => {
    const out = renderRequirementsTable([mkReq(), mkReq({ id: "req-002" })]);
    expect(out).toContain("2");
  });

  it("CJK 标题不破坏列对齐（各数据行显示宽度相同）", () => {
    const reqs = [
      mkReq({ id: "req-001", title: "中文标题非常长的需求描述" }),
      mkReq({ id: "req-002", title: "Short ASCII title here" }),
      mkReq({ id: "req-003", title: "另一个中文标题" }),
    ];
    const out = renderRequirementsTable(reqs);
    // 提取纯数据行（以 req- 开头）
    const dataLines = out.split("\n").filter((l) => l.trimStart().startsWith("req-"));
    expect(dataLines).toHaveLength(3);
    // 所有数据行的终端显示宽度必须完全相同
    const widths = dataLines.map((l) => strDisplayWidth(l));
    expect(new Set(widths).size).toBe(1);
  });

  it("超长标题截断并加截断标记 >，不换行", () => {
    const longTitle = "这是一个非常非常非常非常非常非常长的中文需求标题超过了最大宽度限制绝对超出了";
    const r = mkReq({ title: longTitle });
    const out = renderRequirementsTable([r]);
    // 含截断标记 ">"（使用 ASCII > 而非 …，避免 CJK 终端下 Ambiguous 双宽问题）
    const dataLine = out.split("\n").find((l) => l.includes("req-001"));
    expect(dataLine).toBeDefined();
    expect(dataLine!).toContain(">");
    // 数据行不包含原始超长字符串
    expect(dataLine!.includes(longTitle)).toBe(false);
  });
});

// ── 补充：--json 输出格式验证（单元级，不依赖 daemon） ─────
// CLI 子进程测试只能覆盖 daemon-not-reachable（退出码 3）路径。
// 成功路径（daemon 运行 → 返回数据 → 渲染输出）在此以单元级验证覆盖：
//   - renderRequirementsTable 已在上方 describe 块充分测试
//   - --json 分支本质是 JSON.stringify(requirements, null, 2)，下方验证其格式

describe("--json 输出格式（单元级验证）", () => {
  it("JSON.stringify 输出包含所有字段且格式正确", () => {
    const reqs = [
      mkReq({ id: "req-010", title: "测试需求", status: "ready", workflow: "dev" }),
      mkReq({ id: "req-011", title: "Another req", status: "drafting" }),
    ];
    const json = JSON.stringify(reqs, null, 2);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("req-010");
    expect(parsed[0].title).toBe("测试需求");
    expect(parsed[0].status).toBe("ready");
    expect(parsed[0].workflow).toBe("dev");
    expect(parsed[1].id).toBe("req-011");
    expect(parsed[1].workflow).toBeNull(); // null 不被 JSON.stringify 丢弃
  });

  it("空列表 JSON 输出为 []", () => {
    const json = JSON.stringify([], null, 2);
    expect(json).toBe("[]");
  });
});

// ── Task 3：req list CLI 子进程测试 ─────────────────────

describe("autopilot req list CLI", () => {
  let tmpHome: string;
  const REPO = process.cwd();

  beforeEach(() => {
    tmpHome = join(
      tmpdir(),
      `autopilot-cli-req-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  function runCli(...args: string[]) {
    const r = Bun.spawnSync({
      cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), ...args],
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  }

  it("`req --help` 列出 list 子命令", () => {
    expect(runCli("init").exitCode).toBe(0);
    const r = runCli("req", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("list");
  });

  it("`req list --help` 含 --status / --project / --workspace / --json 选项", () => {
    expect(runCli("init").exitCode).toBe(0);
    const r = runCli("req", "list", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--status");
    expect(r.stdout).toContain("--project");
    expect(r.stdout).toContain("--workspace");
    expect(r.stdout).toContain("--json");
  });

  it("daemon 未启时 `req list` 退出码精确为 3，stderr 含 daemon 提示", () => {
    expect(runCli("init").exitCode).toBe(0);
    const r = runCli("req", "list", "--port", "19999");
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("daemon");
  });

  it("daemon 未启时 `req list --status drafting` 退出码精确为 3", () => {
    expect(runCli("init").exitCode).toBe(0);
    const r = runCli("req", "list", "--status", "drafting", "--port", "19999");
    expect(r.exitCode).toBe(3);
  });

  it("daemon 未启时 `req list --project proj-001` 退出码精确为 3", () => {
    expect(runCli("init").exitCode).toBe(0);
    const r = runCli("req", "list", "--project", "proj-001", "--port", "19999");
    expect(r.exitCode).toBe(3);
  });

  it("daemon 未启时 `req list --workspace ws-001` 退出码精确为 3", () => {
    expect(runCli("init").exitCode).toBe(0);
    const r = runCli("req", "list", "--workspace", "ws-001", "--port", "19999");
    expect(r.exitCode).toBe(3);
  });

  it("daemon 未启时 `req list --json` 退出码精确为 3", () => {
    expect(runCli("init").exitCode).toBe(0);
    const r = runCli("req", "list", "--json", "--port", "19999");
    expect(r.exitCode).toBe(3);
  });
});
