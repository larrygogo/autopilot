import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { getConfigPath } from "./config";
import { initDb, getDb } from "./db";

export type CheckStatus = "ok" | "warning" | "error" | "skipped";
export type CheckCategory = "config" | "provider" | "project" | "codebase";

export type FixId =
  | "init.providers"
  | "fix.config.create";

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
  //
  // 零配置模式（CLAUDE.md 说"provider 自动适配、agent 用内置默认"）：
  // - raw["providers"] 字段完全不存在 → 零配置，所有内置 provider 默认走
  //   CLI 自身管理凭证，doctor L1 不报 error（L2 探测才看 CLI 装没装）
  // - raw["providers"] 存在但为空对象 / 都没 enabled → 用户明确没启用，
  //   保留 error 提示去 /setup 配置（行为不变）
  const hasProvidersSection = raw["providers"] !== undefined;
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
  if (validEnabled.length === 0 && !hasProvidersSection) {
    // 零配置模式：用户没显式配 providers 段，按 CLAUDE.md 设计走"CLI 凭证
    // 自管理"路径。L1 不报错，提示 L2 才能验证 CLI 装没装。
    checks.push({
      id: "providers.has-enabled", category: "provider", status: "ok",
      title: "零配置模式（providers 段未写，依赖 CLI 凭证自管理）",
      detail: "如需切 model / 自建代理，参考 config.yaml 注释里的 providers 段示例；用 --probe 跑 L2 探测验证 CLI 装没装",
    });
  } else if (validEnabled.length === 0) {
    // 用户主动写了 providers 段但都没 enabled — 真错误
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

  // 命名复用 agent 机制已移除（Phase 3）：不再有"全局命名 agent"概念，
  // 每个 phase 内联配置 agent、省略则走 DEFAULT_AGENT 兜底。
  // config.yaml.agents 段不再被框架读取，doctor 也不再对其做健康检查。

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

    // 探测范围（dogfood-bug16）：
    // - 用户显式 enabled providers → 只探测这些（精准对应配置）
    // - 零配置模式（validEnabled 空） → 探测全部三家内置 CLI，让客户看到
    //   "哪个 CLI 装了 / 哪个没装"，否则 --probe 输出空白看不到效果
    const targetForCli = validEnabled.length > 0
      ? validEnabled.map((p) => p.name)
      : Object.keys(providerCliMap);

    await Promise.all(
      targetForCli
        .filter((name) => providerCliMap[name])
        .map(async (name) => {
          const cli = providerCliMap[name];
          const result = await probeCliVersion(cli);
          if (result.ok) {
            checks.push({ id: `providers.${name}.cli`, category: "provider", status: "ok", title: `${name} CLI: ${cli} ${result.version ?? ""} ✓` });
          } else {
            // 零配置场景 CLI 未装不是 error，是 warning（客户可能只用其中一家）
            const isZeroConfig = validEnabled.length === 0;
            checks.push({
              id: `providers.${name}.cli`,
              category: "provider",
              status: isZeroConfig ? "warning" : "error",
              title: `${name} CLI 探测失败`,
              detail: result.detail,
              fix: { cli: result.installHint },
            });
          }
        }),
    );

    if (opts.level >= 3) {
      const targetNames = opts.providers ?? (validEnabled.length > 0
        ? validEnabled.map((p) => p.name)
        : Object.keys(providerCliMap));
      // 串行避免凭证 race
      for (const name of targetNames) {
        const cli = providerCliMap[name];
        if (!cli) continue;
        const result = await pingProviderAuth(cli);
        if (result.ok) {
          checks.push({ id: `providers.${name}.ping`, category: "provider", status: "ok", title: `${name} 凭证验证通过` });
        } else {
          // 零配置场景下 ping 失败也降级为 warning
          const isZeroConfig = validEnabled.length === 0;
          checks.push({
            id: `providers.${name}.ping`,
            category: "provider",
            status: isZeroConfig ? "warning" : "error",
            title: `${name} 凭证验证失败`,
            detail: result.detail,
            fix: { cli: result.loginHint },
          });
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
