# 配置首跑引导 + doctor 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端到端打透 autopilot 配置首跑环节——CLI `config doctor`（L1/L2/L3 分层 + `--fix`）+ Web `/setup` 三步向导 + `task start` 前置校验 + `init` 写带注释配置模板。

**Architecture:** 单一真相源 `src/core/doctor.ts` 暴露 `runChecks({ level })` 返回 `DoctorReport`；CLI / Web / `task start` 都从该模块取检查结果。Web `/setup` 调 daemon 5 个 `/api/setup/*` 端点，端点写 yaml 后回带最新 `DoctorReport`。按 PR-1 → PR-2 → PR-3 → PR-4 顺序独立 merge。

**Tech Stack:** TypeScript / Bun runtime / Commander CLI / Bun.serve HTTP / React + Vite / bun:test。

**Spec:** `docs/superpowers/specs/2026-05-14-config-onboarding-doctor-design.md`

**进程调用约定：** 全部使用 `Bun.spawn` / `Bun.spawnSync`（参照 `src/agents/providers/anthropic.ts`、`src/agents/cli-status.ts`），不使用 node 标准库的子进程 API。

---

## 文件结构

### 新增

| 路径 | 责任 |
|---|---|
| `src/core/doctor.ts` | 单一真相源；导出 `runChecks`、`DoctorReport`、`CheckResult`、`FixId` |
| `src/cli/config.ts` | `config` 命令组注册（doctor / show / path）；调 doctor；格式化输出 |
| `src/cli/config-fix.ts` | `config doctor --fix` 交互式向导；按 `fix.auto` id 路由 |
| `src/cli/config-template.ts` | 生成 `config.yaml` 模板字符串 |
| `src/web/src/pages/Setup.tsx` | `/setup` 三步向导 |
| `src/web/src/components/SetupProgress.tsx` | 顶部进度条 |
| `tests/doctor.test.ts` | L1/L2/L3 单测 |
| `tests/cli-config.test.ts` | doctor 退出码、JSON 格式、--fix |
| `tests/cli-init.test.ts` | init 模板写入 |
| `tests/cli-config-template.test.ts` | 模板生成器 |
| `tests/routes-setup-api.test.ts` | `/api/setup/*` 端点 |
| `tests/task-start-gate.test.ts` | task start 前置校验 |
| `tests/routes-fs-list-host-guard.test.ts` | fs/list host 校验 |

### 修改

| 路径 | 改动 |
|---|---|
| `src/cli/index.ts` | init 调模板 + 末尾提示；task start action 前置 doctor；顶层 doctor 别名；注册 config 命令组 |
| `src/daemon/routes.ts` | 5 个 /api/setup/* 路由；/api/fs/list 加 host 校验 |
| `src/daemon/server.ts` | 启动时把 listen host 注入 routes |
| `src/web/src/App.tsx` | 加 /setup 路由 |
| `src/web/src/hooks/useApi.ts` | 加 setup* API client |
| `src/web/src/pages/Now.tsx` | 顶部检测 status==='error' 时显示 banner |

---

# PR-1：core/doctor.ts + 单测

预估半天，7 个 task。

## Task 1：模块骨架 + 类型定义

**Files:**
- Create: `src/core/doctor.ts`
- Create: `tests/doctor.test.ts`

- [ ] **Step 1：写空模块骨架**

写入 `src/core/doctor.ts`：

```ts
export type CheckStatus = "ok" | "warning" | "error" | "skipped";
export type CheckCategory = "config" | "provider" | "agent" | "project" | "codebase";

export type FixId =
  | "init.providers"
  | "init.agents"
  | "fix.config.create"
  | "fix.agent.unbind-disabled-provider";

export interface CheckResult {
  id: string;
  category: CheckCategory;
  status: CheckStatus;
  title: string;
  detail?: string;
  fix?: { cli?: string; url?: string; auto?: FixId };
}

export interface DoctorReport {
  level: 1 | 2 | 3;
  status: "ok" | "warning" | "error";
  checks: CheckResult[];
  durationMs: number;
  generatedAt: string;
}

export interface RunChecksOptions {
  level: 1 | 2 | 3;
  providers?: string[];
}

export async function runChecks(opts: RunChecksOptions): Promise<DoctorReport> {
  const startedAt = Date.now();
  return {
    level: opts.level,
    status: "ok",
    checks: [],
    durationMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 2：写第一个测试**

写入 `tests/doctor.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runChecks } from "../src/core/doctor";

let tmpFile: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `autopilot-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  tmpFile = join(tmpDir, "config.yaml");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
});
afterEach(() => {
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("doctor.runChecks 基础契约", () => {
  it("返回结构完整", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n");
    const report = await runChecks({ level: 1 });
    expect(report.level).toBe(1);
    expect(["ok", "warning", "error"]).toContain(report.status);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(typeof report.durationMs).toBe("number");
    expect(typeof report.generatedAt).toBe("string");
  });
});
```

- [ ] **Step 3：跑测**

```
bun test tests/doctor.test.ts
```
Expected: 1 pass

- [ ] **Step 4：commit**

```
git add src/core/doctor.ts tests/doctor.test.ts
git commit -m "feat(doctor): 模块骨架 + 类型契约"
```

## Task 2：L1 C1/C2 yaml 存在 + 解析

**Files:**
- Modify: `src/core/doctor.ts`
- Modify: `tests/doctor.test.ts`

- [ ] **Step 1：写测**

追加到 `tests/doctor.test.ts`：

```ts
describe("L1 C1/C2", () => {
  it("yaml 不存在 → status=error", async () => {
    rmSync(tmpFile, { force: true });
    const report = await runChecks({ level: 1 });
    expect(report.status).toBe("error");
    const c1 = report.checks.find((c) => c.id === "config.exists");
    expect(c1?.status).toBe("error");
    expect(c1?.fix?.cli).toContain("init");
  });

  it("yaml 损坏 → C2 报 error 并 stop", async () => {
    writeFileSync(tmpFile, "providers: [this is invalid: {{", "utf-8");
    const report = await runChecks({ level: 1 });
    const c2 = report.checks.find((c) => c.id === "config.parses");
    expect(c2?.status).toBe("error");
    expect(report.checks.find((c) => c.id === "providers.has-enabled")).toBeUndefined();
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/doctor.test.ts
```
Expected: FAIL

- [ ] **Step 3：实现 C1+C2**

`src/core/doctor.ts` 顶部 import 区追加：

```ts
import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { getConfigPath } from "./config";
```

替换 `runChecks` 函数体：

```ts
export async function runChecks(opts: RunChecksOptions): Promise<DoctorReport> {
  const startedAt = Date.now();
  const checks: CheckResult[] = [];
  const path = getConfigPath();

  // C1
  if (!existsSync(path)) {
    checks.push({
      id: "config.exists", category: "config", status: "error",
      title: `config.yaml 不存在（${path}）`,
      fix: { cli: "bun run dev init", auto: "fix.config.create" },
    });
    return finalize(opts, checks, startedAt);
  }
  checks.push({ id: "config.exists", category: "config", status: "ok", title: `config.yaml 已就绪（${path}）` });

  // C2
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(readFileSync(path, "utf-8")) ?? {};
  } catch (e: unknown) {
    checks.push({
      id: "config.parses", category: "config", status: "error",
      title: "config.yaml 解析失败",
      detail: e instanceof Error ? e.message : String(e),
      fix: { cli: "bun run dev config show" },
    });
    return finalize(opts, checks, startedAt);
  }
  checks.push({ id: "config.parses", category: "config", status: "ok", title: "config.yaml 解析正常" });

  void raw; // C3-C7 在 Task 3 补
  return finalize(opts, checks, startedAt);
}

function finalize(opts: RunChecksOptions, checks: CheckResult[], startedAt: number): DoctorReport {
  const status: DoctorReport["status"] = checks.some((c) => c.status === "error")
    ? "error"
    : checks.some((c) => c.status === "warning") ? "warning" : "ok";
  return {
    level: opts.level, status, checks,
    durationMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4：跑测**

```
bun test tests/doctor.test.ts
```
Expected: 3 pass

- [ ] **Step 5：commit**

```
git add src/core/doctor.ts tests/doctor.test.ts
git commit -m "feat(doctor): L1 C1/C2 yaml 存在与解析"
```

## Task 3：L1 C3-C7（结构 + 底线 + 一致性 + agent + projects）

**Files:**
- Modify: `src/core/doctor.ts`
- Modify: `tests/doctor.test.ts`

- [ ] **Step 1：写测**

追加到 `tests/doctor.test.ts`：

```ts
describe("L1 C3-C7", () => {
  it("C4 没有 enabled provider → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: false\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("error");
  });

  it("C4 enabled 但无 default_model → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("error");
  });

  it("C5 agent 引用未启用 provider → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\n  openai:\n    enabled: false\nagents:\n  coder:\n    provider: openai\n", "utf-8");
    const report = await runChecks({ level: 1 });
    const c5 = report.checks.find((c) => c.id === "agents.coder.provider-bound");
    expect(c5?.status).toBe("error");
    expect(c5?.fix?.auto).toBe("fix.agent.unbind-disabled-provider");
  });

  it("C6 无 agent → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "agents.has-any")?.status).toBe("error");
  });

  it("全部合规 → ok", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.status).toBe("ok");
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/doctor.test.ts
```
Expected: FAIL

- [ ] **Step 3：实现 C3-C7**

`src/core/doctor.ts` 顶部 import 区追加：

```ts
import { initDb, getDb } from "./db";
```

在 `runChecks` 内**替换** `void raw;` 占位为：

```ts
  // C3：providers 结构 + 收集 enabled
  const providersSection = (raw["providers"] ?? {}) as Record<string, unknown>;
  const enabledProviders: Array<{ name: string; cfg: Record<string, unknown> }> = [];
  for (const [name, cfg] of Object.entries(providersSection)) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      checks.push({ id: `providers.${name}.structure`, category: "provider", status: "error", title: `providers.${name} 必须是对象` });
      continue;
    }
    const c = cfg as Record<string, unknown>;
    if (c.enabled === true) enabledProviders.push({ name, cfg: c });
  }

  // C4：底线
  const validEnabled = enabledProviders.filter(
    (p) => typeof p.cfg.default_model === "string" && (p.cfg.default_model as string).trim() !== "",
  );
  if (validEnabled.length === 0) {
    checks.push({
      id: "providers.has-enabled", category: "provider", status: "error",
      title: "至少需要启用一个 provider 并填写 default_model",
      detail: enabledProviders.length === 0 ? "没有 enabled: true 的 provider" : `enabled 但缺 default_model: ${enabledProviders.map((p) => p.name).join(", ")}`,
      fix: { cli: "bun run dev config doctor --fix", url: "/setup", auto: "init.providers" },
    });
  } else {
    checks.push({
      id: "providers.has-enabled", category: "provider", status: "ok",
      title: `已启用 ${validEnabled.length} 个 provider：${validEnabled.map((p) => p.name).join(", ")}`,
    });
  }

  // C5：agent 一致性
  const agentsSection = (raw["agents"] ?? {}) as Record<string, unknown>;
  const enabledNames = new Set(validEnabled.map((p) => p.name));
  for (const [agentName, cfg] of Object.entries(agentsSection)) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    const provider = (cfg as Record<string, unknown>).provider as string | undefined;
    if (!provider) {
      checks.push({ id: `agents.${agentName}.provider-bound`, category: "agent", status: "error", title: `agent ${agentName} 未指定 provider`, fix: { cli: "bun run dev config doctor --fix" } });
      continue;
    }
    if (!enabledNames.has(provider)) {
      checks.push({
        id: `agents.${agentName}.provider-bound`, category: "agent", status: "error",
        title: `agent ${agentName} 绑定的 provider=${provider} 未启用`,
        fix: { cli: "bun run dev config doctor --fix", auto: "fix.agent.unbind-disabled-provider" },
      });
    } else {
      checks.push({ id: `agents.${agentName}.provider-bound`, category: "agent", status: "ok", title: `agent ${agentName} ✓ provider=${provider}` });
    }
  }

  // C6
  if (Object.keys(agentsSection).length === 0) {
    checks.push({
      id: "agents.has-any", category: "agent", status: "error",
      title: "至少需要定义一个 agent",
      fix: { cli: "bun run dev config doctor --fix", url: "/setup", auto: "init.agents" },
    });
  } else {
    checks.push({ id: "agents.has-any", category: "agent", status: "ok", title: `已定义 ${Object.keys(agentsSection).length} 个 agent` });
  }

  // C7：projects
  try {
    initDb();
    const cnt = getDb().prepare("SELECT COUNT(*) AS c FROM projects").get() as { c: number };
    if (cnt.c === 0) {
      checks.push({ id: "projects.has-any", category: "project", status: "warning", title: "暂无 project，可在 dashboard 创建", fix: { url: "/library?tab=projects" } });
    } else {
      checks.push({ id: "projects.has-any", category: "project", status: "ok", title: `共 ${cnt.c} 个 project` });
    }
  } catch {}
```

- [ ] **Step 4：跑测**

```
bun test tests/doctor.test.ts
```
Expected: 8 pass

- [ ] **Step 5：commit**

```
git add src/core/doctor.ts tests/doctor.test.ts
git commit -m "feat(doctor): L1 C3-C7 业务规则"
```

## Task 4：L2 provider CLI 探测（Bun.spawn）

**Files:**
- Modify: `src/core/doctor.ts`
- Modify: `tests/doctor.test.ts`

参考：`src/agents/cli-status.ts` 已经用 `Bun.spawn` + 超时 controller 跑 CLI `--version` 探测，模式可直接借用。

- [ ] **Step 1：写测**

追加到 `tests/doctor.test.ts`：

```ts
describe("L2 provider CLI 探测", () => {
  it("L2 包含 L1 全部检查", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 2 });
    expect(report.level).toBe(2);
    expect(report.checks.find((c) => c.id === "config.exists")).toBeDefined();
  });

  it("L2 对未启用 provider 跳过 CLI 探测", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\n  openai:\n    enabled: false\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 2 });
    expect(report.checks.find((c) => c.id === "providers.openai.cli")).toBeUndefined();
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/doctor.test.ts
```
Expected: FAIL

- [ ] **Step 3：实现 L2**

在 `src/core/doctor.ts` 的 `runChecks` 内 C7 块**之后**、`return finalize(...)` 之前插入：

```ts
  // L2 / L3
  if (opts.level >= 2) {
    const providerCliMap: Record<string, string> = {
      anthropic: "claude",
      openai: "codex",
      google: "gemini",
    };

    await Promise.all(
      validEnabled
        .filter((p) => providerCliMap[p.name])
        .map(async ({ name }) => {
          const cli = providerCliMap[name];
          const result = await probeCliVersion(cli);
          if (result.ok) {
            checks.push({ id: `providers.${name}.cli`, category: "provider", status: "ok", title: `${name} CLI: ${cli} ${result.version ?? ""} ✓` });
          } else {
            checks.push({ id: `providers.${name}.cli`, category: "provider", status: "error", title: `${name} CLI 探测失败`, detail: result.detail, fix: { cli: result.installHint } });
          }
        }),
    );

    // L3 在 Task 5 补
  }
```

在文件底部追加辅助：

```ts
interface ProbeResult {
  ok: boolean;
  version?: string;
  detail?: string;
  installHint?: string;
  loginHint?: string;
}

async function probeCliVersion(cli: string, timeoutMs = 5000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proc = Bun.spawn([cli, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
    });
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode === 0) {
      const version = (stdout || stderr).trim().split(/\s+/).find((s) => /\d+\.\d+/.test(s));
      return { ok: true, version };
    }
    return { ok: false, detail: `${cli} 退出码 ${exitCode}: ${stderr.slice(0, 300)}`, installHint: installHintFor(cli) };
  } catch (e: unknown) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      detail: aborted ? `探测超时（${timeoutMs}ms）` : `${cli} 未在 PATH 中：${e instanceof Error ? e.message : String(e)}`,
      installHint: installHintFor(cli),
    };
  }
}

function installHintFor(cli: string): string {
  switch (cli) {
    case "claude":  return "请安装 Claude Code CLI：见 https://docs.anthropic.com/en/docs/claude-code";
    case "codex":   return "npm i -g @openai/codex";
    case "gemini":  return "npm i -g @google/gemini-cli";
    default:        return `请确保 ${cli} 在 PATH 中`;
  }
}
```

- [ ] **Step 4：跑测**

```
bun test tests/doctor.test.ts
```
Expected: 10 pass

- [ ] **Step 5：commit**

```
git add src/core/doctor.ts tests/doctor.test.ts
git commit -m "feat(doctor): L2 provider CLI 探测（Bun.spawn --version）"
```

## Task 5：L3 凭证 ping

**Files:**
- Modify: `src/core/doctor.ts`
- Modify: `tests/doctor.test.ts`

- [ ] **Step 1：写测**

追加：

```ts
describe("L3 凭证 ping", () => {
  it("L3 模式 level 字段为 3", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 3 });
    expect(report.level).toBe(3);
  });

  it("providers 空数组 → 不跑任何 L3 ping", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 3, providers: [] });
    expect(report.checks.find((c) => c.id === "providers.anthropic.ping")).toBeUndefined();
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/doctor.test.ts
```
Expected: FAIL

- [ ] **Step 3：实现 L3**

在 L2 块（`if (opts.level >= 2) { ... }`）内部、`// L3 在 Task 5 补` 占位处插入：

```ts
    if (opts.level >= 3) {
      const targetNames = opts.providers ?? validEnabled.map((p) => p.name);
      // 串行避免凭证 race
      for (const name of targetNames) {
        const cli = providerCliMap[name];
        if (!cli) continue;
        const result = await pingProviderAuth(cli);
        if (result.ok) {
          checks.push({ id: `providers.${name}.ping`, category: "provider", status: "ok", title: `${name} 凭证验证通过` });
        } else {
          checks.push({ id: `providers.${name}.ping`, category: "provider", status: "error", title: `${name} 凭证验证失败`, detail: result.detail, fix: { cli: result.loginHint } });
        }
      }
    }
```

在文件底部追加：

```ts
async function pingProviderAuth(cli: string, timeoutMs = 10000): Promise<ProbeResult> {
  const args = cli === "claude"
    ? ["-p", "ping", "--output-format", "json", "--max-turns", "1"]
    : cli === "codex"
    ? ["exec", "--json", "--skip-git-repo-check", "-"]
    : ["-p", "ping", "--yolo"];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proc = Bun.spawn([cli, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: cli === "codex" ? "pipe" : "ignore",
      signal: controller.signal,
    });
    if (cli === "codex" && proc.stdin) {
      const sink = proc.stdin as unknown as { write: (s: string) => unknown; end: () => unknown };
      sink.write("ping\n");
      sink.end();
    }
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const stderr = await new Response(proc.stderr).text();
    if (exitCode === 0) return { ok: true };
    const detail = stderr.slice(0, 400);
    const looksLikeAuth = /auth|login|credential|unauthorized|401/i.test(detail);
    return {
      ok: false,
      detail: looksLikeAuth ? `未登录或凭证失效：${detail}` : `调用失败 (exit=${exitCode}): ${detail}`,
      loginHint: looksLikeAuth ? loginHintFor(cli) : "重试 `bun run dev config doctor --probe`",
    };
  } catch (e: unknown) {
    clearTimeout(timer);
    return {
      ok: false,
      detail: controller.signal.aborted ? `ping 超时（${timeoutMs}ms）` : e instanceof Error ? e.message : String(e),
      loginHint: loginHintFor(cli),
    };
  }
}

function loginHintFor(cli: string): string {
  switch (cli) {
    case "claude":  return "claude login";
    case "codex":   return "codex login";
    case "gemini":  return "gemini auth login";
    default:        return `${cli} login`;
  }
}
```

- [ ] **Step 4：跑测**

```
bun test tests/doctor.test.ts
```
Expected: 12 pass

- [ ] **Step 5：commit**

```
git add src/core/doctor.ts tests/doctor.test.ts
git commit -m "feat(doctor): L3 凭证 ping（串行避免 race）"
```

## Task 6：契约稳定性 + typecheck

**Files:**
- Modify: `tests/doctor.test.ts`

- [ ] **Step 1：写测**

追加：

```ts
describe("报告契约", () => {
  it("DoctorReport JSON.stringify 安全", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 1 });
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.status).toBe(report.status);
    expect(parsed.checks.length).toBe(report.checks.length);
  });

  it("所有 fix.auto 在 FixId 白名单内", async () => {
    rmSync(tmpFile, { force: true });
    const r1 = await runChecks({ level: 1 });
    writeFileSync(tmpFile, "providers: {}\nagents: {}\n", "utf-8");
    const r2 = await runChecks({ level: 1 });
    const allFix = [...r1.checks, ...r2.checks].map((c) => c.fix?.auto).filter(Boolean);
    const allowed = ["init.providers", "init.agents", "fix.config.create", "fix.agent.unbind-disabled-provider"];
    for (const id of allFix) expect(allowed).toContain(id!);
  });
});
```

- [ ] **Step 2：跑测 + typecheck**

```
bun test tests/doctor.test.ts
bun run typecheck
```
Expected: 14 pass + 无类型错误

- [ ] **Step 3：commit**

```
git add tests/doctor.test.ts
git commit -m "test(doctor): JSON 安全性 + FixId 白名单"
```

## Task 7：PR-1 推 PR

- [ ] **Step 1：切分支并推**

```
git checkout -b feat/doctor-core-20260514
git push -u origin feat/doctor-core-20260514
gh pr create --base main --title "feat(doctor): core/doctor.ts 单一真相源（L1/L2/L3）" --body "L1 静态校验 + L2 provider CLI 探测 + L3 凭证 ping，14 个测试覆盖。后续 PR-2/3/4 依赖此模块。"
```

- [ ] **Step 2：merge 后回 main**

```
git checkout main && git pull
```

---

# PR-2：init 模板 + config 命令组 + --fix

预估 1 天，5 个 task。

## Task 8：config 模板生成器

**Files:**
- Create: `src/cli/config-template.ts`
- Create: `tests/cli-config-template.test.ts`

- [ ] **Step 1：写测**

写入 `tests/cli-config-template.test.ts`：

```ts
import { describe, it, expect } from "bun:test";
import { parse as parseYaml } from "yaml";
import { buildConfigTemplate } from "../src/cli/config-template";

describe("config-template", () => {
  it("是合法 yaml", () => {
    expect(() => parseYaml(buildConfigTemplate())).not.toThrow();
  });

  it("anthropic 默认启用且填了 default_model", () => {
    const parsed = parseYaml(buildConfigTemplate()) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;
    expect((providers.anthropic as Record<string, unknown>).enabled).toBe(true);
    expect((providers.anthropic as Record<string, unknown>).default_model).toBe("claude-sonnet-4-6");
  });

  it("openai / google 段保持注释", () => {
    const txt = buildConfigTemplate();
    const parsed = parseYaml(txt) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;
    expect(providers.openai).toBeUndefined();
    expect(providers.google).toBeUndefined();
    expect(txt).toContain("# openai:");
    expect(txt).toContain("# google:");
  });

  it("含 doctor 引导注释", () => {
    expect(buildConfigTemplate()).toContain("bun run dev config doctor");
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/cli-config-template.test.ts
```
Expected: FAIL

- [ ] **Step 3：实现**

写入 `src/cli/config-template.ts`：

```ts
export function buildConfigTemplate(): string {
  return `# autopilot 配置文件。
# 用 \`bun run dev config doctor\` 检查当前状态。
# providers / agents 是最少需要填的两项。

providers:
  anthropic:
    default_model: claude-sonnet-4-6
    enabled: true

  # openai:
  #   default_model: gpt-5
  #   enabled: true
  #
  # google:
  #   default_model: gemini-2.5-pro
  #   enabled: true

agents:
  coder:
    provider: anthropic
    model: claude-sonnet-4-6
    max_turns: 10
    permission_mode: auto
`;
}
```

- [ ] **Step 4：跑测**

```
bun test tests/cli-config-template.test.ts
```
Expected: 4 pass

- [ ] **Step 5：commit**

```
git add src/cli/config-template.ts tests/cli-config-template.test.ts
git commit -m "feat(cli): 引入 config.yaml 首跑模板"
```

## Task 9：init 调模板 + 末尾打印下一步

**Files:**
- Modify: `src/cli/index.ts`
- Create: `tests/cli-init.test.ts`

- [ ] **Step 1：写测**

写入 `tests/cli-init.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function runInit() {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), "init"],
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

describe("init 写模板", () => {
  it("首次 init 后 config.yaml 存在且 anthropic 已启用", () => {
    const r = runInit();
    expect(r.exitCode).toBe(0);
    const cfgPath = join(tmpHome, "config.yaml");
    expect(existsSync(cfgPath)).toBe(true);
    expect(readFileSync(cfgPath, "utf-8")).toContain("default_model: claude-sonnet-4-6");
  });

  it("二次 init 不覆盖已有 config.yaml", () => {
    runInit();
    const cfgPath = join(tmpHome, "config.yaml");
    writeFileSync(cfgPath, "providers: {}\n# my edits\n", "utf-8");
    runInit();
    expect(readFileSync(cfgPath, "utf-8")).toContain("my edits");
  });

  it("init 输出包含三个下一步提示", () => {
    const r = runInit();
    expect(r.stdout).toContain("bun run dev config doctor");
    expect(r.stdout).toContain("--fix");
    expect(r.stdout).toContain("dashboard");
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/cli-init.test.ts
```
Expected: FAIL

- [ ] **Step 3：改 init action**

`src/cli/index.ts` 顶部 import 区追加（与已有 fs import 合并）：

```ts
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { buildConfigTemplate } from "./config-template";
```

定位 `program.command("init")` 块（约第 891 行），替换 action 函数体：

```ts
  .action(() => {
    const dirs = [
      join(AUTOPILOT_HOME, "workflows"),
      join(AUTOPILOT_HOME, "prompts"),
      join(AUTOPILOT_HOME, "runtime"),
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      console.log(`已创建目录：${dir}`);
    }
    initDb();
    console.log(`已初始化数据库：${join(AUTOPILOT_HOME, "runtime", "workflow.db")}`);

    const cfgPath = join(AUTOPILOT_HOME, "config.yaml");
    if (!existsSync(cfgPath)) {
      writeFileSync(cfgPath, buildConfigTemplate(), "utf-8");
      console.log(`已生成配置模板：${cfgPath}`);
    } else {
      console.log(`配置文件已存在，保留：${cfgPath}`);
    }

    console.log("\n初始化完成。下一步（三选一）：");
    console.log("  » bun run dev config doctor       检查配置");
    console.log("  » bun run dev config doctor --fix 交互式配置");
    console.log("  » bun run dev dashboard           浏览器配置");
  });
```

- [ ] **Step 4：跑测**

```
bun test tests/cli-init.test.ts
```
Expected: 3 pass

- [ ] **Step 5：commit**

```
git add src/cli/index.ts tests/cli-init.test.ts
git commit -m "feat(cli): init 写配置模板 + 打印下一步提示"
```

## Task 10：config 命令组（doctor / show / path / --json）

**Files:**
- Create: `src/cli/config.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli-config.test.ts`

- [ ] **Step 1：写测**

写入 `tests/cli-config.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-cli-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("config doctor 退出码", () => {
  it("配置完整 → 0", () => {
    runCli("init");
    const r = runCli("config", "doctor");
    expect(r.exitCode).toBe(0);
  });

  it("缺 provider → 2", () => {
    runCli("init");
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const r = runCli("config", "doctor");
    expect(r.exitCode).toBe(2);
  });

  it("--json 可解析", () => {
    runCli("init");
    const r = runCli("config", "doctor", "--json");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.level).toBe(1);
    expect(parsed.status).toBe("ok");
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe("config path / show", () => {
  it("config path 打印绝对路径", () => {
    runCli("init");
    const r = runCli("config", "path");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(join(tmpHome, "config.yaml"));
  });

  it("config show 打印 yaml 原文", () => {
    runCli("init");
    const r = runCli("config", "show");
    expect(r.stdout).toContain("default_model: claude-sonnet-4-6");
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/cli-config.test.ts
```
Expected: FAIL

- [ ] **Step 3：实现**

写入 `src/cli/config.ts`：

```ts
import type { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { runChecks, type DoctorReport } from "../core/doctor";
import { getConfigPath } from "../core/config";
import { initDb } from "../core/db";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("配置管理（init / 检查 / 修复）");

  config
    .command("doctor")
    .description("检查配置（默认 L1；--probe 走 L2+L3）")
    .option("--probe", "包含 L2 CLI + L3 凭证探测")
    .option("--json", "JSON 输出")
    .option("--fix", "交互式修复向导")
    .action(async (opts: { probe?: boolean; json?: boolean; fix?: boolean }) => {
      if (opts.fix) {
        const { runFixWizard } = await import("./config-fix");
        await runFixWizard();
        return;
      }
      try { initDb(); } catch {}
      const level = opts.probe ? 3 : 1;
      let report: DoctorReport;
      try {
        report = await runChecks({ level });
      } catch (e: unknown) {
        console.error(`doctor 自身异常：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
      if (opts.json) console.log(JSON.stringify(report));
      else printReport(report);
      process.exit(exitCodeFor(report.status));
    });

  config
    .command("show")
    .description("打印 config.yaml 原文（脱敏 base_url 凭证）")
    .action(() => {
      const p = getConfigPath();
      if (!existsSync(p)) {
        console.error(`config.yaml 不存在：${p}`);
        process.exit(1);
      }
      console.log(redactCredentials(readFileSync(p, "utf-8")));
    });

  config
    .command("path")
    .description("打印 config.yaml 绝对路径")
    .action(() => { console.log(getConfigPath()); });
}

export function printReport(report: DoctorReport): void {
  const lvLabel = report.level === 1 ? "L1 静态" : report.level === 2 ? "L2 + CLI" : "L3 全探测";
  for (const c of report.checks) {
    const icon = c.status === "ok" ? "[✓]" : c.status === "warning" ? "[!]" : c.status === "skipped" ? "[-]" : "[✗]";
    console.log(`${icon} ${c.title}`);
    if (c.detail) console.log(`      ${c.detail}`);
    if (c.fix?.cli) console.log(`      修复：${c.fix.cli}`);
    if (c.fix?.url) console.log(`      或访问：${c.fix.url}`);
  }
  const errors = report.checks.filter((c) => c.status === "error").length;
  const warnings = report.checks.filter((c) => c.status === "warning").length;
  console.log(`${lvLabel} (${errors} errors, ${warnings} warnings)`);
}

function exitCodeFor(status: DoctorReport["status"]): number {
  return status === "ok" ? 0 : status === "warning" ? 1 : 2;
}

function redactCredentials(yaml: string): string {
  return yaml.replace(/(base_url:\s*['"]?)([^'"\s]+:\/\/)([^@'"\s]+)@/g, "$1$2***@");
}
```

- [ ] **Step 4：注册到 `src/cli/index.ts`**

import 区追加：

```ts
import { registerConfigCommands } from "./config";
```

在已有 `registerWorkflowCommands(program);` 之后追加：

```ts
registerConfigCommands(program);
```

- [ ] **Step 5：跑测 + commit**

```
bun test tests/cli-config.test.ts
git add src/cli/config.ts src/cli/index.ts tests/cli-config.test.ts
git commit -m "feat(cli): config 命令组（doctor / show / path / --json）"
```
Expected: 5 pass

## Task 11：--fix 交互式向导

**Files:**
- Create: `src/cli/config-fix.ts`
- Modify: `tests/cli-config.test.ts`

- [ ] **Step 1：写测**

追加：

```ts
describe("config doctor --fix 交互式", () => {
  it("空 config + 输入选 anthropic + 默认 model + agent name=coder", () => {
    runCli("init");
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const stdin = ["anthropic", "claude-sonnet-4-6", "coder", "anthropic", ""].join("\n") + "\n";

    const r = Bun.spawnSync({
      cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), "config", "doctor", "--fix"],
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);

    const yaml = readFileSync(join(tmpHome, "config.yaml"), "utf-8");
    expect(yaml).toContain("default_model: claude-sonnet-4-6");
    expect(yaml).toMatch(/agents:[\s\S]*coder:[\s\S]*provider:\s*anthropic/);
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/cli-config.test.ts -t "doctor --fix 交互式"
```
Expected: FAIL（config-fix 不存在）

- [ ] **Step 3：实现**

写入 `src/cli/config-fix.ts`：

```ts
import { createInterface } from "node:readline";
import { saveProvider, saveAgent, PROVIDER_NAMES, type ProviderName } from "../core/config";

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5",
  google: "gemini-2.5-pro",
};

const LOGIN_CMDS: Record<ProviderName, string> = {
  anthropic: "claude login",
  openai: "codex login",
  google: "gemini auth login",
};

/**
 * 交互式修复向导。处理 `init.providers` / `init.agents`。
 * 凭证类操作永远不代办，向导结束统一打印「仍需手动」清单。
 */
export async function runFixWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, res));

  const manualSteps: string[] = [];

  const allProviders = PROVIDER_NAMES.join(", ");
  const raw = (await ask(`? 启用哪些 provider？（多选用逗号分隔，可选：${allProviders}） » `)).trim();
  const chosen = raw.split(",").map((s) => s.trim()).filter(
    (s): s is ProviderName => (PROVIDER_NAMES as readonly string[]).includes(s),
  );
  if (chosen.length === 0) {
    console.log("未选任何 provider，向导退出。");
    rl.close();
    return;
  }

  for (const name of chosen) {
    const model = (await ask(`? ${name} 默认 model（回车用 ${DEFAULT_MODELS[name]}）» `)).trim() || DEFAULT_MODELS[name];
    saveProvider(name, { enabled: true, default_model: model });
    manualSteps.push(`$ ${LOGIN_CMDS[name]}`);
  }

  while (true) {
    const agentName = (await ask("? 创建一个 agent（回车跳过）» 名字：")).trim();
    if (!agentName) break;
    const provider = (await ask(`? 该 agent 用哪个 provider？（${chosen.join("/")}）» `)).trim() as ProviderName;
    if (!chosen.includes(provider)) {
      console.log(`! 无效 provider，跳过 ${agentName}`);
      continue;
    }
    saveAgent(agentName, {
      provider,
      model: DEFAULT_MODELS[provider],
      max_turns: 10,
      permission_mode: "auto",
    });
    console.log(`✓ 已写入 agent ${agentName}`);
  }

  rl.close();
  console.log("\n✓ 已写入 ~/.autopilot/config.yaml");
  if (manualSteps.length > 0) {
    console.log("\n仍需手动：");
    for (const s of manualSteps) console.log(`  ${s}`);
  }
}
```

- [ ] **Step 4：跑测**

```
bun test tests/cli-config.test.ts -t "doctor --fix 交互式"
```
Expected: pass

- [ ] **Step 5：commit**

```
git add src/cli/config-fix.ts tests/cli-config.test.ts
git commit -m "feat(cli): config doctor --fix 交互式修复向导"
```

## Task 12：PR-2 推 PR

- [ ] **Step 1：全量测试 + typecheck**

```
bun test
bun run typecheck
```
Expected: 全部通过

- [ ] **Step 2：切分支推 PR**

```
git checkout -b feat/config-cli-20260514
git push -u origin feat/config-cli-20260514
gh pr create --base main --title "feat(cli): config 命令组 + init 模板 + 交互式修复" --body "init 生成模板（不覆盖）；新增 config doctor / show / path / --probe / --json / --fix。依赖 PR-1。"
```

- [ ] **Step 3：merge 后回 main**

```
git checkout main && git pull
```

---

# PR-3：HTTP API + Web /setup

预估 1 天，8 个 task。

## Task 13：daemon `/api/setup/status` 路由 + 必要时建 kv 表

**Files:**
- Modify: `src/daemon/routes.ts`
- Create: `tests/routes-setup-api.test.ts`
- 可能 Create: `src/migrations/017_kv_table.ts`

- [ ] **Step 1：先查 kv 表存不存在**

```
grep -rn "CREATE TABLE.*kv\|TABLE kv" src/migrations/ src/core/db.ts
```

- 如**有**结果：跳过 Step 2
- 如**无**结果：执行 Step 2

- [ ] **Step 2：建 kv 迁移**

查最后迁移序号：

```
ls src/migrations/ | sort
```

假设最大是 016，新建 `src/migrations/017_kv_table.ts`：

```ts
import type { Database } from "bun:sqlite";

export default {
  id: 17,
  name: "kv 简单键值表",
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
```

参考已有迁移在 `src/migrations/index.ts`（或迁移注册表）注册新增。

- [ ] **Step 3：写测**

写入 `tests/routes-setup-api.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest } from "../src/daemon/routes";
import { initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

let tmpHome: string;
beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-setup-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  process.env.DEV_WORKFLOW_CONFIG = join(tmpHome, "config.yaml");
  writeFileSync(join(tmpHome, "config.yaml"), "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
  initDb();
  await runPendingMigrations();
});
afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("GET /api/setup/status", () => {
  it("返回 DoctorReport（level=1）", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/setup/status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.level).toBe(1);
    expect(body.status).toBe("ok");
    expect(Array.isArray(body.checks)).toBe(true);
  });
});
```

- [ ] **Step 4：跑测看挂**

```
bun test tests/routes-setup-api.test.ts
```
Expected: FAIL (404)

- [ ] **Step 5：实现路由**

在 `src/daemon/routes.ts` 的 `// ─────────── 文件系统浏览 ───────────` 块**之前**插入：

```ts
    // ─────────── 首跑配置（setup） ───────────

    if (method === "GET" && path === "/api/setup/status") {
      const { runChecks } = await import("../core/doctor");
      const { getDb } = await import("../core/db");
      const report = await runChecks({ level: 1 });
      let dismissed = false;
      try {
        const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get("setup.dismissed") as { value: string } | undefined;
        dismissed = row?.value === "1";
      } catch {}
      return json({ ...report, setupDismissed: dismissed });
    }
```

- [ ] **Step 6：跑测 + commit**

```
bun test tests/routes-setup-api.test.ts
git add src/daemon/routes.ts tests/routes-setup-api.test.ts src/migrations/
git commit -m "feat(daemon): GET /api/setup/status 返回 DoctorReport"
```
Expected: 1 pass

## Task 14：POST `/api/setup/providers|agents|codebases|dismiss`

**Files:**
- Modify: `src/daemon/routes.ts`
- Modify: `tests/routes-setup-api.test.ts`

- [ ] **Step 1：写测**

追加：

```ts
describe("POST /api/setup/*", () => {
  it("POST /providers 写入 + 返回最新 report", async () => {
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/setup/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: { anthropic: { enabled: true, default_model: "claude-sonnet-4-6" } } }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.checks.find((c: { id: string }) => c.id === "providers.has-enabled")?.status).toBe("ok");
  });

  it("POST /agents 写入", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/setup/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: { coder: { provider: "anthropic", model: "x", max_turns: 10, permission_mode: "auto" } } }),
    }));
    expect(res.status).toBe(200);
  });

  it("POST /dismiss 标记 dismiss", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/setup/dismiss", { method: "POST" }));
    expect(res.status).toBe(200);

    const status = await handleRequest(new Request("http://127.0.0.1:6180/api/setup/status"));
    const body = await status.json();
    expect(body.setupDismissed).toBe(true);
  });

  it("非法 body → 400", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/setup/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: "not an object" }),
    }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/routes-setup-api.test.ts
```
Expected: 4 FAIL

- [ ] **Step 3：实现 4 个 POST 路由**

在 status 路由之后追加：

```ts
    if (method === "POST" && path === "/api/setup/providers") {
      const { saveProvider, PROVIDER_NAMES } = await import("../core/config");
      const { runChecks } = await import("../core/doctor");
      const body = await req.json().catch(() => null) as { providers?: Record<string, unknown> } | null;
      if (!body || typeof body.providers !== "object" || body.providers === null || Array.isArray(body.providers)) {
        return error("providers must be an object", 400);
      }
      for (const [name, cfg] of Object.entries(body.providers)) {
        if (!(PROVIDER_NAMES as readonly string[]).includes(name)) continue;
        if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
          saveProvider(name as typeof PROVIDER_NAMES[number], cfg as Record<string, unknown>);
        }
      }
      const report = await runChecks({ level: 1 });
      return json({ report });
    }

    if (method === "POST" && path === "/api/setup/agents") {
      const { saveAgent } = await import("../core/config");
      const { runChecks } = await import("../core/doctor");
      const body = await req.json().catch(() => null) as { agents?: Record<string, unknown> } | null;
      if (!body || typeof body.agents !== "object" || body.agents === null || Array.isArray(body.agents)) {
        return error("agents must be an object", 400);
      }
      for (const [name, cfg] of Object.entries(body.agents)) {
        if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
          saveAgent(name, cfg as Record<string, unknown>);
        }
      }
      const report = await runChecks({ level: 1 });
      return json({ report });
    }

    if (method === "POST" && path === "/api/setup/codebases") {
      const { createCodebase } = await import("../core/codebases");
      const body = await req.json().catch(() => null) as
        | { name?: string; path?: string; project_id?: string }
        | null;
      if (!body?.name || !body?.path) {
        return error("name and path required", 400);
      }
      const cb = createCodebase({ alias: body.name, path: body.path, project_id: body.project_id ?? null });
      return json({ codebase: cb });
    }

    if (method === "POST" && path === "/api/setup/dismiss") {
      const { getDb } = await import("../core/db");
      getDb().prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .run("setup.dismissed", "1");
      return json({ ok: true });
    }
```

> 如果 `createCodebase` 参数命名与 `{ alias, path, project_id }` 不同，按 `src/core/codebases.ts` 实际签名调整。

- [ ] **Step 4：跑测 + commit**

```
bun test tests/routes-setup-api.test.ts
git add src/daemon/routes.ts tests/routes-setup-api.test.ts
git commit -m "feat(daemon): /api/setup/providers|agents|codebases|dismiss"
```
Expected: 5 pass

## Task 15：Web useApi 扩展

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`

- [ ] **Step 1：查看现有结构**

```
grep -n "export const api\|browseFs" src/web/src/hooks/useApi.ts
```

- [ ] **Step 2：在 useApi.ts 顶部追加类型**

```ts
export interface DoctorCheck {
  id: string;
  category: "config" | "provider" | "agent" | "project" | "codebase";
  status: "ok" | "warning" | "error" | "skipped";
  title: string;
  detail?: string;
  fix?: { cli?: string; url?: string; auto?: string };
}

export interface DoctorReportWithDismiss {
  level: 1 | 2 | 3;
  status: "ok" | "warning" | "error";
  checks: DoctorCheck[];
  durationMs: number;
  generatedAt: string;
  setupDismissed?: boolean;
}
```

- [ ] **Step 3：api 对象末尾追加方法**

```ts
  async setupStatus(): Promise<DoctorReportWithDismiss> {
    return request<DoctorReportWithDismiss>("/api/setup/status");
  },

  async setupProviders(providers: Record<string, Record<string, unknown>>): Promise<{ report: DoctorReportWithDismiss }> {
    return request("/api/setup/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers }),
    });
  },

  async setupAgents(agents: Record<string, Record<string, unknown>>): Promise<{ report: DoctorReportWithDismiss }> {
    return request("/api/setup/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents }),
    });
  },

  async setupCodebase(payload: { name: string; path: string; project_id?: string }): Promise<{ codebase: unknown }> {
    return request("/api/setup/codebases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  async setupDismiss(): Promise<{ ok: boolean }> {
    return request("/api/setup/dismiss", { method: "POST" });
  },
```

- [ ] **Step 4：typecheck + commit**

```
bun run typecheck
git add src/web/src/hooks/useApi.ts
git commit -m "feat(web): useApi 扩展 setup 系列 API client"
```

## Task 16：`<SetupProgress>` 进度条

**Files:**
- Create: `src/web/src/components/SetupProgress.tsx`

- [ ] **Step 1：写组件**

写入 `src/web/src/components/SetupProgress.tsx`：

```tsx
import { cn } from "@/lib/utils";

export interface SetupProgressProps {
  current: 1 | 2 | 3;
  labels?: [string, string, string];
}

const DEFAULT_LABELS: [string, string, string] = ["Provider", "Agent", "Codebase"];

export function SetupProgress({ current, labels = DEFAULT_LABELS }: SetupProgressProps) {
  return (
    <ol className="mb-6 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.12em]">
      {labels.map((label, idx) => {
        const step = (idx + 1) as 1 | 2 | 3;
        const isActive = step === current;
        const isDone = step < current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center border-[1.5px] font-bold",
                isActive && "border-foreground bg-foreground text-background",
                isDone && "border-foreground/60 text-foreground/60",
                !isActive && !isDone && "border-foreground/30 text-foreground/30",
              )}
            >
              {step}
            </span>
            <span className={cn(!isActive && "text-muted-foreground")}>{label}</span>
            {step < 3 && <span className="text-muted-foreground">———</span>}
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 2：commit**

```
git add src/web/src/components/SetupProgress.tsx
git commit -m "feat(web): SetupProgress 进度条组件"
```

## Task 17：`<Setup>` 三步向导

**Files:**
- Create: `src/web/src/pages/Setup.tsx`

- [ ] **Step 1：写组件**

写入 `src/web/src/pages/Setup.tsx`：

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DoctorReportWithDismiss } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { SetupProgress } from "@/components/SetupProgress";
import { FolderPicker } from "@/components/FolderPicker";

type ProviderName = "anthropic" | "openai" | "google";
const ALL_PROVIDERS: { name: ProviderName; defaultModel: string; loginHint: string }[] = [
  { name: "anthropic", defaultModel: "claude-sonnet-4-6", loginHint: "claude login" },
  { name: "openai",    defaultModel: "gpt-5",             loginHint: "codex login" },
  { name: "google",    defaultModel: "gemini-2.5-pro",    loginHint: "gemini auth login" },
];

export function Setup() {
  const navigate = useNavigate();
  const toast = useToast();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [report, setReport] = useState<DoctorReportWithDismiss | null>(null);

  const [enabledProviders, setEnabledProviders] = useState<Record<ProviderName, boolean>>({
    anthropic: true, openai: false, google: false,
  });
  const [models, setModels] = useState<Record<ProviderName, string>>({
    anthropic: "claude-sonnet-4-6", openai: "gpt-5", google: "gemini-2.5-pro",
  });

  const [agentName, setAgentName] = useState("coder");
  const [agentProvider, setAgentProvider] = useState<ProviderName>("anthropic");

  const [cbName, setCbName] = useState("");
  const [cbPath, setCbPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api.setupStatus().then(setReport).catch(() => {});
  }, []);

  async function submitStep1() {
    const payload: Record<string, Record<string, unknown>> = {};
    for (const p of ALL_PROVIDERS) {
      if (enabledProviders[p.name]) {
        payload[p.name] = { enabled: true, default_model: models[p.name] };
      }
    }
    if (Object.keys(payload).length === 0) {
      toast.error("至少选一个 provider", "");
      return;
    }
    try {
      const { report } = await api.setupProviders(payload);
      setReport(report);
      const first = ALL_PROVIDERS.find((p) => enabledProviders[p.name])?.name;
      if (first) setAgentProvider(first);
      setStep(2);
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    }
  }

  async function submitStep2() {
    if (!agentName.trim()) { toast.error("agent 名不能为空", ""); return; }
    try {
      const { report } = await api.setupAgents({
        [agentName.trim()]: {
          provider: agentProvider,
          model: models[agentProvider],
          max_turns: 10,
          permission_mode: "auto",
        },
      });
      setReport(report);
      setStep(3);
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    }
  }

  async function submitStep3OrSkip(skip: boolean) {
    if (!skip) {
      if (!cbName.trim() || !cbPath.trim()) { toast.error("name / path 不能为空", ""); return; }
      try {
        await api.setupCodebase({ name: cbName.trim(), path: cbPath.trim() });
      } catch (e: unknown) {
        toast.error("创建 codebase 失败", (e as Error)?.message ?? String(e));
        return;
      }
    }
    await api.setupDismiss().catch(() => {});
    navigate("/now");
  }

  const minimumReady = report && report.checks.find((c) => c.id === "agents.has-any")?.status === "ok";

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-4 border-b-[1.5px] border-foreground/30 pb-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider">首跑向导 · SETUP</h1>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground mt-1">
          完成 3 步即可开始使用 autopilot
        </p>
      </header>

      <SetupProgress current={step} />

      {step === 3 && minimumReady && (
        <div className="mb-4 border-[1.5px] border-foreground/30 px-3 py-2 font-mono text-xs">
          ✓ 核心配置已就绪 · 第 3 步可选
        </div>
      )}

      {step === 1 && (
        <section className="space-y-4">
          <h2 className="font-mono text-sm font-bold uppercase">1/3 · 启用 Provider</h2>
          {ALL_PROVIDERS.map((p) => (
            <div key={p.name} className="flex items-center gap-3">
              <Checkbox
                checked={enabledProviders[p.name]}
                onCheckedChange={(v) => setEnabledProviders((m) => ({ ...m, [p.name]: v === true }))}
                id={`pv-${p.name}`}
              />
              <Label htmlFor={`pv-${p.name}`} className="flex-1 font-mono">{p.name}</Label>
              <Input
                className="w-56 font-mono"
                value={models[p.name]}
                onChange={(e) => setModels((m) => ({ ...m, [p.name]: e.target.value }))}
                disabled={!enabledProviders[p.name]}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            ⚠ 凭证需在终端手动登录：
            {ALL_PROVIDERS.filter((p) => enabledProviders[p.name]).map((p) => (
              <code key={p.name} className="mx-1">$ {p.loginHint}</code>
            ))}
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button onClick={submitStep1}>下一步 →</Button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4">
          <h2 className="font-mono text-sm font-bold uppercase">2/3 · 创建 Agent</h2>
          <div>
            <Label htmlFor="agent-name">名字</Label>
            <Input id="agent-name" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
          </div>
          <div>
            <Label>Provider</Label>
            <select
              className="block w-full border-[1.5px] bg-background p-2 font-mono"
              value={agentProvider}
              onChange={(e) => setAgentProvider(e.target.value as ProviderName)}
            >
              {ALL_PROVIDERS.filter((p) => enabledProviders[p.name]).map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => setStep(1)}>← 上一步</Button>
            <Button onClick={submitStep2}>下一步 →</Button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4">
          <h2 className="font-mono text-sm font-bold uppercase">3/3 · 添加 Codebase（可选）</h2>
          <div>
            <Label htmlFor="cb-name">名称</Label>
            <Input id="cb-name" value={cbName} onChange={(e) => setCbName(e.target.value)} placeholder="my-project" />
          </div>
          <div>
            <Label htmlFor="cb-path">本地路径</Label>
            <div className="flex gap-2">
              <Input id="cb-path" value={cbPath} onChange={(e) => setCbPath(e.target.value)} />
              <Button variant="outline" onClick={() => setPickerOpen(true)}>浏览…</Button>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => setStep(2)}>← 上一步</Button>
            <Button variant="outline" onClick={() => submitStep3OrSkip(true)}>跳过</Button>
            <Button onClick={() => submitStep3OrSkip(false)}>完成</Button>
          </div>

          <FolderPicker
            open={pickerOpen}
            initialPath={cbPath || undefined}
            onSelect={(p) => { setCbPath(p); setPickerOpen(false); }}
            onCancel={() => setPickerOpen(false)}
          />
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2：commit**

```
git add src/web/src/pages/Setup.tsx
git commit -m "feat(web): Setup.tsx 三步向导（Provider/Agent/Codebase）"
```

## Task 18：注册 `/setup` 路由

**Files:**
- Modify: `src/web/src/App.tsx`

- [ ] **Step 1：lazy import 区追加**

在 `const SettingsHub = lazy(...)` 附近追加：

```ts
const Setup = lazy(() => import("./pages/Setup").then((m) => ({ default: m.Setup })));
```

- [ ] **Step 2：Routes 注册**

定位 `<Route path="*" element={<Navigate to="/now" replace />} />`，在它**之前**追加：

```tsx
                <Route path="/setup" element={<Setup />} />
```

- [ ] **Step 3：build + commit**

```
bun run build:web
git add src/web/src/App.tsx
git commit -m "feat(web): 注册 /setup 路由"
```

## Task 19：`/now` 顶部 banner

**Files:**
- Modify: `src/web/src/pages/Now.tsx`

- [ ] **Step 1：加 banner**

文件 import 区合并：

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DoctorReportWithDismiss } from "@/hooks/useApi";
```

`Now` 组件函数体起始处追加：

```tsx
  const [setupReport, setSetupReport] = useState<DoctorReportWithDismiss | null>(null);
  useEffect(() => {
    api.setupStatus().then(setSetupReport).catch(() => {});
  }, []);
  const showSetupBanner = !!setupReport && setupReport.status === "error" && !setupReport.setupDismissed;
```

return JSX 顶部插入：

```tsx
      {showSetupBanner && (
        <div className="mb-4 border-[1.5px] border-foreground/30 p-3 font-mono text-sm">
          ⚠ 未完成首跑配置
          <Link to="/setup" className="ml-2 underline">开始 ▸</Link>
        </div>
      )}
```

- [ ] **Step 2：手测**

```
bun run build:web
```

启动 daemon、浏览器访问 `/now`，断 config（写空 yaml）后刷新，banner 应出现；走完 setup dismiss 后 banner 消失。

- [ ] **Step 3：commit**

```
git add src/web/src/pages/Now.tsx
git commit -m "feat(web): /now 顶部提示未完成首跑配置"
```

## Task 20：PR-3 推 PR

- [ ] **Step 1：全量测试 + typecheck + build**

```
bun test
bun run typecheck
bun run build:web
```
Expected: 全过

- [ ] **Step 2：切分支推 PR**

```
git checkout -b feat/setup-wizard-20260514
git push -u origin feat/setup-wizard-20260514
gh pr create --base main --title "feat(web): /setup 三步向导 + setup HTTP API" --body "5 个 /api/setup/* 端点；三步向导（Provider/Agent/Codebase 可跳）；/now 顶部 banner；kv 表迁移（如新建）。依赖 PR-1、PR-2。"
```

- [ ] **Step 3：merge 后回 main**

```
git checkout main && git pull
```

---

# PR-4：task start 前置 + fs/list host 校验 + doctor 别名

预估半天，4 个 task。

## Task 21：daemon host 注入 routes

**Files:**
- Modify: `src/daemon/routes.ts`
- Modify: `src/daemon/server.ts`

- [ ] **Step 1：routes.ts 顶部加 setter/getter**

在 `src/daemon/routes.ts` 文件顶部（其他 export 附近）追加：

```ts
let CURRENT_LISTEN_HOST: string | null = null;
export function setListenHost(host: string): void {
  CURRENT_LISTEN_HOST = host;
}
export function getListenHost(): string | null {
  return CURRENT_LISTEN_HOST;
}
```

- [ ] **Step 2：server.ts 启动时调用**

`src/daemon/server.ts` 中 `const server = Bun.serve({...})` 之前追加：

```ts
  const { setListenHost } = await import("./routes");
  setListenHost(opts.host);
```

- [ ] **Step 3：commit**

```
git add src/daemon/routes.ts src/daemon/server.ts
git commit -m "feat(daemon): 把 listen host 注入 routes"
```

## Task 22：`/api/fs/list` host 校验

**Files:**
- Modify: `src/daemon/routes.ts`
- Create: `tests/routes-fs-list-host-guard.test.ts`

- [ ] **Step 1：写测**

写入 `tests/routes-fs-list-host-guard.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest, setListenHost } from "../src/daemon/routes";

let tmpHome: string;
beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-fs-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});
afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  setListenHost("127.0.0.1");
});

describe("/api/fs/list host 校验", () => {
  it("127.0.0.1 → 200", async () => {
    setListenHost("127.0.0.1");
    const res = await handleRequest(new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(tmpHome)}`));
    expect(res.status).toBe(200);
  });

  it("0.0.0.0 → 403", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(tmpHome)}`));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("fs-browser-disabled-on-public-bind");
  });

  it("192.168.x → 403", async () => {
    setListenHost("192.168.1.100");
    const res = await handleRequest(new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(tmpHome)}`));
    expect(res.status).toBe(403);
  });

  it("localhost → 200", async () => {
    setListenHost("localhost");
    const res = await handleRequest(new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(tmpHome)}`));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/routes-fs-list-host-guard.test.ts
```
Expected: 3 FAIL

- [ ] **Step 3：实现守卫**

定位 `if (method === "GET" && path === "/api/fs/list") {`，在 `const reqPath = ...` **之前**插入：

```ts
      const host = getListenHost() ?? "127.0.0.1";
      if (!isLoopbackHost(host)) {
        return error("fs-browser-disabled-on-public-bind", 403);
      }
```

文件底部追加：

```ts
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  if (h === "::1" || h === "[::1]") return true;
  return false;
}
```

- [ ] **Step 4：跑测 + commit**

```
bun test tests/routes-fs-list-host-guard.test.ts
git add src/daemon/routes.ts tests/routes-fs-list-host-guard.test.ts
git commit -m "fix(daemon): /api/fs/list 非 loopback 绑定时拒绝访问"
```
Expected: 4 pass

## Task 23：`task start` 前置 doctor + 顶层 `doctor` 别名

**Files:**
- Modify: `src/cli/index.ts`
- Create: `tests/task-start-gate.test.ts`

- [ ] **Step 1：写测**

写入 `tests/task-start-gate.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-task-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("task start 前置 doctor", () => {
  it("空 config → 退出码 2 + 提示 fix", () => {
    runCli("init");
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const r = runCli("task", "start", "test-task");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("doctor --fix");
  });

  it("顶层 doctor 别名等同 config doctor", () => {
    runCli("init");
    const r = runCli("doctor");
    expect(r.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/task-start-gate.test.ts
```
Expected: 2 FAIL

- [ ] **Step 3：实现前置**

`src/cli/index.ts` 顶部 import 区追加：

```ts
import { runChecks as runDoctorChecks } from "../core/doctor";
import { printReport as printDoctorReport } from "./config";
```

定位 `task.command("start <title>").action(async (...)`，函数体起始处（在 `const client = getClient(opts);` 之前）插入：

```ts
    try {
      const preflight = await runDoctorChecks({ level: 2 });
      if (preflight.status === "error") {
        console.error("配置不就绪，请先修复：");
        printDoctorReport(preflight);
        console.error("\n或运行：bun run dev config doctor --fix");
        process.exit(2);
      }
    } catch (e: unknown) {
      console.error(`doctor 探测失败：${e instanceof Error ? e.message : String(e)}`);
      process.exit(3);
    }
```

定位顶层 `program.command("start <title>").action(...)`（task start 别名），插入相同代码块。

- [ ] **Step 4：注册顶层 doctor 别名**

在 `registerConfigCommands(program);` 之后追加：

```ts
program
  .command("doctor")
  .description("config doctor 的顶层别名")
  .option("--probe", "包含 L2 + L3 探测")
  .option("--json", "JSON 输出")
  .option("--fix", "交互式修复")
  .action(async (opts: { probe?: boolean; json?: boolean; fix?: boolean }) => {
    const args = ["config", "doctor"];
    if (opts.probe) args.push("--probe");
    if (opts.json) args.push("--json");
    if (opts.fix) args.push("--fix");
    await program.parseAsync([process.argv[0], process.argv[1], ...args], { from: "user" });
  });
```

- [ ] **Step 5：跑测 + commit**

```
bun test tests/task-start-gate.test.ts
git add src/cli/index.ts tests/task-start-gate.test.ts
git commit -m "feat(cli): task start 前置 doctor + 顶层 doctor 别名"
```
Expected: 2 pass

## Task 24：PR-4 推 PR

- [ ] **Step 1：全量测试 + typecheck + build**

```
bun test
bun run typecheck
bun run build:web
```
Expected: 全过

- [ ] **Step 2：切分支推 PR**

```
git checkout -b feat/task-start-gate-20260514
git push -u origin feat/task-start-gate-20260514
gh pr create --base main --title "feat(cli): task start 前置 doctor + fs/list host 校验" --body "task start 前置跑 doctor L2，error 时拦截；新增顶层 doctor 别名；fs/list 非 loopback 时返回 403。依赖 PR-1/2/3。"
```

- [ ] **Step 3：merge 后回 main**

```
git checkout main && git pull
```

---

## 全流程 dogfood

四个 PR 全部 merge 后跑一次：

```
rm -rf /tmp/autopilot-dogfood
export AUTOPILOT_HOME=/tmp/autopilot-dogfood

# 1) init 写模板 + 提示
bun run dev init

# 2) doctor L1
bun run dev config doctor

# 3) --probe L2+L3
bun run dev config doctor --probe

# 4) 启 daemon + 浏览器走 /setup
bun run dev daemon start
# 浏览器：http://127.0.0.1:6180/setup

# 5) 空 config task start 应被拦
AUTOPILOT_HOME=/tmp/autopilot-empty bun run dev task start test
```

每一步与 spec 一致。
