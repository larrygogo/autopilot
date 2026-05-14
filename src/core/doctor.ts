import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { getConfigPath } from "./config";
import { initDb, getDb } from "./db";

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
  } catch {
    // DB 不可用时跳过 C7，不影响整体检查流程
  }

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
  }

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
      const sink = proc.stdin as unknown as { write: (s: string) => Promise<number> | number; end: () => unknown };
      await sink.write("ping\n");
      sink.end();
    }
    const exitCode = await proc.exited;
    clearTimeout(timer);
    // 必须把 stdout 也消费掉，否则 CLI 输出大时（如 claude json）会塞满 pipe buffer → back-pressure 死锁
    await new Response(proc.stdout).text();
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
