/**
 * dogfood-bug22 / bug23 回归测试。
 *
 * bug22：CLI getClient 之前因为 commander 注入 `--port` default 值，永远走
 * fallback parseInt(defaultPort)，listen.json 被忽略。客户改 config.json
 * daemon.port=16180 后跑 `daemon status` 报"daemon 运行中 (pid=主daemon)"
 * 因为 client 实际连 6180。
 *
 * bug23：`req new --no-extract` 之前不生效。commander 把 `--no-extract`
 * 解析为 `{ extract: false }`，没有 `noExtract` 字段。代码用 `opts.noExtract`
 * 永远 undefined → 永远走 extract 分支调 LLM。
 */
import { describe, it, expect } from "bun:test";
import { Command } from "commander";

describe("commander --no-extract 解析行为（dogfood-bug23）", () => {
  it("commander 把 --no-extract 解析为 extract:false（不是 noExtract）", () => {
    let captured: Record<string, unknown> | null = null;
    const p = new Command();
    p.command("test")
      .option("--no-extract", "desc")
      .action((opts) => {
        captured = opts;
      });
    p.parse(["node", "t", "test", "--no-extract"], { from: "node" });
    expect(captured).not.toBeNull();
    // 关键断言：是 extract:false，不是 noExtract:true
    expect(captured!.extract).toBe(false);
    expect(captured!.noExtract).toBeUndefined();
  });

  it("不传 --no-extract 时 opts.extract 默认 true（commander 行为）", () => {
    let captured: Record<string, unknown> | null = null;
    const p = new Command();
    p.command("test")
      .option("--no-extract", "desc")
      .action((opts) => {
        captured = opts;
      });
    p.parse(["node", "t", "test"], { from: "node" });
    expect(captured!.extract).toBe(true);
  });
});

describe("CLI --port default 行为（dogfood-bug22）", () => {
  it("commander 把 --port default 6180 永远注入 opts.port", () => {
    let captured: Record<string, unknown> | null = null;
    const p = new Command();
    p.command("test")
      .option("-p, --port <p>", "port", "6180")
      .action((opts) => {
        captured = opts;
      });
    // 不传 --port，commander 仍然注入 default 值
    p.parse(["node", "t", "test"], { from: "node" });
    expect(captured!.port).toBe("6180");
  });

  it("用户显式 --port 16180 覆盖 default", () => {
    let captured: Record<string, unknown> | null = null;
    const p = new Command();
    p.command("test")
      .option("-p, --port <p>", "port", "6180")
      .action((opts) => {
        captured = opts;
      });
    p.parse(["node", "t", "test", "--port", "16180"], { from: "node" });
    expect(captured!.port).toBe("16180");
  });
});

describe("端口解析优先级逻辑（bug22 fix）", () => {
  // 抽出 getClient 的端口选择纯函数，单测无需 daemon
  function resolvePort(opts: { port?: string } | undefined, listenInfoPort: number | null, defaultPort: number): number {
    const explicitPort =
      opts?.port && parseInt(opts.port, 10) !== defaultPort
        ? parseInt(opts.port, 10)
        : null;
    return explicitPort ?? listenInfoPort ?? defaultPort;
  }

  it("用户显式 --port 16180 + listen.json=17000 → 用 16180（显式覆盖优先）", () => {
    expect(resolvePort({ port: "16180" }, 17000, 6180)).toBe(16180);
  });

  it("opts.port==='6180' (default) + listen.json=16180 → 用 16180（listen.json 优先）", () => {
    expect(resolvePort({ port: "6180" }, 16180, 6180)).toBe(16180);
  });

  it("opts.port==='6180' + listen.json=null → 用 6180（fallback default）", () => {
    expect(resolvePort({ port: "6180" }, null, 6180)).toBe(6180);
  });

  it("opts undefined + listen.json=16180 → 用 16180", () => {
    expect(resolvePort(undefined, 16180, 6180)).toBe(16180);
  });

  it("opts undefined + listen.json=null → 用 6180", () => {
    expect(resolvePort(undefined, null, 6180)).toBe(6180);
  });

  it("用户显式 --port 等于 default 6180 + listen.json=16180 → 仍用 16180（无法区分 default vs explicit，倾向 listen.json）", () => {
    // 这是已知妥协：commander 没法区分用户显式传入 default 跟自动注入 default。
    // 跨 HOME 场景用户应该 export AUTOPILOT_HOME 而非靠 --port 6180 区分。
    expect(resolvePort({ port: "6180" }, 16180, 6180)).toBe(16180);
  });
});

/**
 * bug24: tui + dashboard 命令也走 resolvePort，跟随客户改的 daemon.port。
 *
 * 之前 tui 直接 `startTui({ port: parseInt(opts.port, 10) })`、dashboard
 * 拼 URL 用 opts.port —— 都硬编码 default 6180，客户改端口后必连错。
 */
describe("tui + dashboard 端口解析（dogfood-bug24）", () => {
  import("fs").then(({ mkdirSync, writeFileSync, rmSync, existsSync }) => {
    // intentionally empty —— 真正测试在下面 spawn CLI
  });

  it("dashboard 命令 listen.json 存在时打印的 URL 用 listen.json 的端口", async () => {
    const { join } = await import("path");
    const { mkdirSync, writeFileSync, rmSync, existsSync } = await import("fs");
    const { tmpdir } = await import("os");
    const tmpHome = join(
      tmpdir(),
      `autopilot-dash-port-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tmpHome, "runtime"), { recursive: true });
    writeFileSync(
      join(tmpHome, "runtime", "daemon.listen.json"),
      JSON.stringify({ host: "127.0.0.1", port: 16180 }),
      "utf-8",
    );
    try {
      const r = Bun.spawnSync({
        cmd: ["bun", "run", join(process.cwd(), "bin/autopilot.ts"), "dashboard"],
        // AUTOPILOT_NO_BROWSER：只验证打印的 URL，不真正拉起浏览器（否则每次 bun test 都刷开 tab）
        env: { ...process.env, AUTOPILOT_HOME: tmpHome, AUTOPILOT_NO_BROWSER: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      const out = r.stdout.toString();
      // URL 应该用 16180 而不是 default 6180
      expect(out).toContain("127.0.0.1:16180");
      expect(out).not.toContain("127.0.0.1:6180");
      // 确认走了跳过分支，没有真正打开浏览器
      expect(out).toContain("跳过自动打开");
    } finally {
      if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("dashboard 命令 listen.json 不存在时 fallback default port", async () => {
    const { join } = await import("path");
    const { mkdirSync, rmSync, existsSync } = await import("fs");
    const { tmpdir } = await import("os");
    const tmpHome = join(
      tmpdir(),
      `autopilot-dash-default-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tmpHome, "runtime"), { recursive: true });
    try {
      const r = Bun.spawnSync({
        cmd: ["bun", "run", join(process.cwd(), "bin/autopilot.ts"), "dashboard"],
        env: { ...process.env, AUTOPILOT_HOME: tmpHome, AUTOPILOT_NO_BROWSER: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      const out = r.stdout.toString();
      // 没 listen.json → 用默认 6180
      expect(out).toContain("127.0.0.1:6180");
      expect(out).toContain("跳过自动打开");
    } finally {
      if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
