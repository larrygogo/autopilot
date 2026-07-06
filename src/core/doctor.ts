import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getConfigPath } from "./config";
import { initDb, getDb } from "./db";
import { listProviders } from "./providers";
import { listUsableProviders } from "./default-provider";
import { getCurrentVersion, latestMigrationVersion } from "./migrate";
import { listOutdatedWorkflowCopies } from "./workflow/templates";
import { isStandaloneBinary } from "./runtime-env";

export type CheckStatus = "ok" | "warning" | "error" | "skipped";
export type CheckCategory = "config" | "provider" | "project" | "workspace" | "upgrade";

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

/**
 * task-start 守卫判据：是否存在「会让任务跑不起来」的阻塞问题。
 * = 任何 error，**或**没有可用 provider（providers.has-enabled 非 ok）。
 *
 * 「无可用 provider」在 doctor 里是 warning（onboarding 正常态，诊断不该 exit 1，见
 * has-enabled 注释）——但起任务是关键操作，必须有可用 provider 才放行，故这里单独把它
 * 升格为阻塞条件。「warn 不拒启」的强制落在这个 task-start 守卫上，而非诊断命令的退出码。
 */
export function hasTaskStartBlocker(report: DoctorReport): boolean {
  if (report.status === "error") return true;
  const prov = report.checks.find((c) => c.id === "providers.has-enabled");
  return !!prov && prov.status !== "ok";
}

export async function runChecks(opts: RunChecksOptions): Promise<DoctorReport> {
  const startedAt = Date.now();
  const checks: CheckResult[] = [];
  const path = getConfigPath();

  // C1
  if (!existsSync(path)) {
    checks.push({
      id: "config.exists", category: "config", status: "error",
      title: `config.json 不存在（${path}）`,
      fix: { cli: "bun run dev init", auto: "fix.config.create" },
    });
    return finalize(opts, checks, startedAt);
  }
  checks.push({ id: "config.exists", category: "config", status: "ok", title: `config.json 已就绪（${path}）` });

  // C2
  let raw: Record<string, unknown>;
  try {
    const content = readFileSync(path, "utf-8");
    raw = content.trim() ? (JSON.parse(content) as Record<string, unknown>) : {};
  } catch (e: unknown) {
    checks.push({
      id: "config.parses", category: "config", status: "error",
      title: "config.json 解析失败",
      detail: e instanceof Error ? e.message : String(e),
      fix: { cli: "bun run dev config show" },
    });
    return finalize(opts, checks, startedAt);
  }
  checks.push({ id: "config.parses", category: "config", status: "ok", title: "config.json 解析正常" });

  // C3：providers 段结构校验（仅查 config.json 形状，真相源是 providers 条目表）
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
    // warning 而非 error：未配置 provider 是 onboarding 的正常初始态，doctor 只引导不阻塞
    // exit（bug 16/17「warning 不阻塞 exit」契约 + 「warn 不拒启」哲学）。真正的强制由
    // task-start 关键操作守卫 + Web 横幅承担，那才是 gate，不该让诊断工具 exit 1。
    checks.push({
      id: "providers.has-enabled", category: "provider", status: "warning",
      title: "有 provider 条目，但没有一个可用",
      detail: "CLI 未登录 或 API key 未配 —— autopilot 需要至少一个可用供应商才能执行任务（澄清 / 入队 / 起任务会被拒）。",
      fix: { cli: "autopilot provider list  # 看状态，再 CLI 登录 或 autopilot key set <provider>", url: "/settings/providers", auto: "init.providers" },
    });
  } else {
    checks.push({
      id: "providers.has-enabled", category: "provider", status: "warning",
      title: "未配置任何 AI 供应商",
      detail: "在「设置 → 提供商」添加并登录 / 填 API key。",
      fix: { url: "/settings/providers", auto: "init.providers" },
    });
  }

  // 命名复用 agent 机制已移除（Phase 3）：不再有"全局命名 agent"概念，
  // 每个 phase 内联配置 agent、省略则走 DEFAULT_AGENT 兜底。
  // config.json.agents 段不再被框架读取，doctor 也不再对其做健康检查。

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

  // ── C8：升级完整性自检 —— 抓「git pull 后忘了某一步」的半升级中间态。
  // 全是 warning（引导补步骤，不阻塞）；升级是「pull + install + upgrade + build:web + sync」
  // 几步散落手动操作，漏一步就静默不一致，这里一次性扫出来。
  //
  // C8a：未应用迁移（pull 了新迁移但没 autopilot upgrade / 没重启 daemon）
  try {
    initDb();
    const current = getCurrentVersion();
    const latest = latestMigrationVersion();
    // current>0 守卫：current===0 = 从未迁移过（全新未 init / 测试夹具 DB），不是「落后」——
    // 那条路由 config.exists / init 覆盖，doctor 不在此误报。
    if (latest > 0 && current > 0 && current < latest) {
      checks.push({
        id: "upgrade.migrations", category: "upgrade", status: "warning",
        title: `有 ${latest - current} 条未应用迁移（当前 v${current} → 最新 v${latest}）`,
        detail: "git pull 后忘了升级？跑 autopilot upgrade 应用新迁移。",
        fix: { cli: "autopilot upgrade" },
      });
    }
  } catch { /* DB 不可用 → 跳过 */ }

  // C8b：工作流副本落后内置模板（examples 有上游修复未 sync）
  try {
    const outdated = listOutdatedWorkflowCopies();
    if (outdated.length > 0) {
      checks.push({
        id: "upgrade.workflows", category: "upgrade", status: "warning",
        title: `${outdated.length} 个工作流副本落后于内置模板：${outdated.map((o) => o.name).join("、")}`,
        detail: "examples 有上游修复未同步到你的副本（统一布局下旧副本的 git 任务可能 fatal）。",
        fix: { cli: `autopilot workflow sync ${outdated[0].name} --apply` },
      });
    }
  } catch { /* ignore */ }

  // C8c：Web UI bundle 是否比 src/web 源码旧（git pull 后忘了 bun run build:web）。
  // 仅在「src/web 与 web-dist 都存在」时检查 stale；web-dist 缺失不在此报（那条由
  // serveStatic 的「未构建」指引页覆盖，且测试/CI 不构建 web-dist——只查 stale 才 test-safe）。
  // 编译单文件模式：import.meta.dir 是虚拟路径，源码仓库不存在，跳过此检查。
  if (isStandaloneBinary()) {
    checks.push({
      id: "upgrade.webdist", category: "upgrade", status: "skipped",
      title: "打包运行，跳过源码仓库检查（Web UI bundle 检测不适用）",
    });
  } else {
    try {
      const repoRoot = join(import.meta.dir, "..", "..");
      const srcWebDir = join(repoRoot, "src", "web", "src");
      const webDistIndex = join(repoRoot, "web-dist", "index.html");
      if (existsSync(srcWebDir) && existsSync(webDistIndex) && newestMtime(srcWebDir) > statSync(webDistIndex).mtimeMs) {
        checks.push({
          id: "upgrade.webdist", category: "upgrade", status: "warning",
          title: "Web UI bundle 可能过期（src/web 比上次构建新）",
          detail: "git pull 更新了前端源码但没重建；跑 bun run build:web 后刷新页面。",
          fix: { cli: "bun run build:web" },
        });
      }
    } catch { /* ignore */ }
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

/** 递归取目录下所有文件的最新 mtime（ms）。读失败的条目跳过。给「web-dist 是否过期」用。 */
function newestMtime(dir: string): number {
  let newest = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      newest = st.isDirectory() ? Math.max(newest, newestMtime(full)) : Math.max(newest, st.mtimeMs);
    } catch {
      /* 跳过读不到的条目 */
    }
  }
  return newest;
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
