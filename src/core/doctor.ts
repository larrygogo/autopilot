import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { getConfigPath } from "./config";
import { initDb, getDb } from "./db";
import { listProviders } from "./providers";
import { listUsableProviders } from "./default-provider";

export type CheckStatus = "ok" | "warning" | "error" | "skipped";
export type CheckCategory = "config" | "provider" | "project" | "workspace";

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

  // C3：providers 段结构校验（仅查 config.yaml 形状，真相源是 providers 条目表）
  const providersSection = (raw["providers"] ?? {}) as Record<string, unknown>;
  for (const [name, cfg] of Object.entries(providersSection)) {
    if (name === "default") continue; // providers.default 是字符串保留键，非条目
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      checks.push({ id: `providers.${name}.structure`, category: "provider", status: "error", title: `providers.${name} 必须是对象` });
    }
  }

  // C4：底线——是否有「真正可用」的 provider（条目表 + 可用性：cli 已登录 ok / api 有 key）。
  // 「有条目」≠「能用」：providers 表总被 seed，关键是有没有一个登录好 / 配了 key 的。
  // 注：可用性读条目表的 cli_status（DB 落库值，不在此 spawn CLI），故 env-independent。
  let entryCount = 0;
  let usableNames: string[] = [];
  try {
    initDb();
    entryCount = listProviders().length;
    usableNames = (await listUsableProviders()).map((p) => p.name);
  } catch { /* DB 未就绪 → 按 0 处理（下面给 error 引导） */ }

  if (usableNames.length > 0) {
    checks.push({
      id: "providers.has-enabled", category: "provider", status: "ok",
      title: `已有 ${usableNames.length} 个可用 AI 供应商：${usableNames.join(", ")}`,
    });
  } else if (entryCount > 0) {
    checks.push({
      id: "providers.has-enabled", category: "provider", status: "error",
      title: "有 provider 条目，但没有一个可用",
      detail: "CLI 未登录 或 API key 未配 —— autopilot 需要至少一个可用供应商才能执行任务（澄清 / 入队 / 起任务会被拒）。",
      fix: { cli: "autopilot provider list  # 看状态，再 CLI 登录 或 autopilot key set <provider>", url: "/settings/providers", auto: "init.providers" },
    });
  } else {
    checks.push({
      id: "providers.has-enabled", category: "provider", status: "error",
      title: "未配置任何 AI 供应商",
      detail: "在「设置 → 提供商」添加并登录 / 填 API key。",
      fix: { url: "/settings/providers", auto: "init.providers" },
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

    // 探测范围：全部三家内置 CLI（条目化后无「config 显式 enabled 子集」概念；
    // 让客户看到「哪个 CLI 装了 / 哪个没装」，否则 --probe 输出空白看不到效果）。
    const targetForCli: string[] = Object.keys(providerCliMap);

    await Promise.all(
      targetForCli
        .filter((name) => providerCliMap[name])
        .map(async (name) => {
          const cli = providerCliMap[name];
          const result = await probeCliVersion(cli);
          if (result.ok) {
            checks.push({ id: `providers.${name}.cli`, category: "provider", status: "ok", title: `${name} CLI: ${cli} ${result.version ?? ""} ✓` });
          } else {
            // 单个 CLI 未装/未登录是 warning（客户可能只用其中一家）；
            // 「一个可用的都没有」的 error 由上面 providers.has-enabled 底线统一报。
            checks.push({
              id: `providers.${name}.cli`,
              category: "provider",
              status: "warning",
              title: `${name} CLI 探测失败`,
              detail: result.detail,
              fix: { cli: result.installHint },
            });
          }
        }),
    );

    if (opts.level >= 3) {
      const targetNames = opts.providers ?? (usableNames.length > 0 ? usableNames : Object.keys(providerCliMap));
      // 串行避免凭证 race
      for (const name of targetNames) {
        const cli = providerCliMap[name];
        if (!cli) continue;
        const result = await pingProviderAuth(cli);
        if (result.ok) {
          checks.push({ id: `providers.${name}.ping`, category: "provider", status: "ok", title: `${name} 凭证验证通过` });
        } else {
          // 单家凭证验证失败 = warning（其它家可能可用）；「全无可用」的 error 由底线统一报。
          checks.push({
            id: `providers.${name}.ping`,
            category: "provider",
            status: "warning",
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
