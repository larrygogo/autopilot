import type { ProviderName } from "../core/config";

// ──────────────────────────────────────────────
// Provider 对应的本地 CLI 二进制检测
// Anthropic / OpenAI / Google 三家 provider 均通过 Bun.spawn 调本地 CLI
// （claude / codex / gemini）子进程，凭证由各 CLI 自身管理。
// ──────────────────────────────────────────────

export interface ProviderCliStatus {
  name: ProviderName;
  cli_installed: boolean;
  /** 二进制绝对路径（检测到时） */
  cli_path?: string;
  /** 版本号第一行 */
  cli_version?: string;
  /** 出错信息（未安装 / 运行失败 / 超时） */
  error?: string;
  /** 推荐的安装命令（未安装时展示给用户） */
  install_hint?: string;
}

interface CliSpec {
  bin: string;
  install: string;
}

// CLI 规格按 subtype（provider 条目化：claude/codex/gemini）。官方 name → subtype 复用。
const SUBTYPE_CLI_SPEC: Record<string, CliSpec> = {
  claude: { bin: "claude", install: "npm i -g @anthropic-ai/claude-code  # 然后 `claude login`" },
  codex: { bin: "codex", install: "npm i -g @openai/codex  # 然后 `codex login`" },
  gemini: { bin: "gemini", install: "npm i -g @google/gemini-cli  # 然后 `gemini auth login`" },
};

const CLI_SPEC: Record<ProviderName, CliSpec> = {
  anthropic: SUBTYPE_CLI_SPEC.claude,
  openai: SUBTYPE_CLI_SPEC.codex,
  google: SUBTYPE_CLI_SPEC.gemini,
};

async function runShort(argv: string[], timeoutMs = 3000): Promise<{ ok: boolean; stdout: string; stderr: string; err?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", signal: controller.signal });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, stdout: "", stderr: "", err };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 `<cli> --version` 的首行非空输出 */
function firstLine(s: string): string | undefined {
  const line = s.split("\n").find((l) => l.trim().length > 0);
  return line?.trim();
}

export async function detectProviderCli(name: ProviderName): Promise<ProviderCliStatus> {
  const spec = CLI_SPEC[name];
  if (!spec) {
    return { name, cli_installed: false, error: `未知 provider：${name}` };
  }

  // 1. 用 Bun.which 跨平台查找二进制（Windows 自动识别 .exe / .cmd）。
  //    不要外挂 `which` —— Windows 无此命令；也不要用 `where` —— 它返回多行 \r\n
  //    结果，且 PowerShell 别名会干扰判断。
  const cliPath = Bun.which(spec.bin);
  if (!cliPath) {
    return {
      name,
      cli_installed: false,
      error: `未在 PATH 中找到 \`${spec.bin}\``,
      install_hint: spec.install,
    };
  }

  // 2. 跑 --version 取版本号
  const ver = await runShort([spec.bin, "--version"]);
  if (!ver.ok) {
    return {
      name,
      cli_installed: true,
      cli_path: cliPath,
      error: `\`${spec.bin} --version\` 运行失败：${ver.stderr || ver.err || "unknown"}`,
      install_hint: spec.install,
    };
  }
  return {
    name,
    cli_installed: true,
    cli_path: cliPath,
    cli_version: firstLine(ver.stdout) ?? firstLine(ver.stderr),
  };
}

export async function detectAllProviders(): Promise<Record<ProviderName, ProviderCliStatus>> {
  const names: ProviderName[] = ["anthropic", "openai", "google"];
  const results = await Promise.all(names.map((n) => detectProviderCli(n)));
  const out = {} as Record<ProviderName, ProviderCliStatus>;
  for (const r of results) out[r.name] = r;
  return out;
}

// ── provider 条目化：按 subtype 探测 CLI（含自定义 binary） ──

export interface CliProbeResult {
  status: "ok" | "missing" | "unknown";
  version?: string;
  path?: string;
  install_hint?: string;
  error?: string;
}

/**
 * 按 subtype（claude/codex/gemini）或自定义 binary 探测本地 CLI 可用性。
 * 供 provider 条目（type=cli）的添加探测 + 后台刷新用。
 */
export async function probeCli(subtype: string, customBin?: string): Promise<CliProbeResult> {
  const spec = SUBTYPE_CLI_SPEC[subtype];
  const bin = customBin || spec?.bin;
  if (!bin) return { status: "unknown", error: `未知 CLI 子类型：${subtype}（且未提供自定义 binary）` };

  const path = Bun.which(bin);
  if (!path) {
    return { status: "missing", install_hint: spec?.install, error: `未在 PATH 中找到 \`${bin}\`` };
  }
  const ver = await runShort([bin, "--version"]);
  if (!ver.ok) {
    return { status: "unknown", path, install_hint: spec?.install, error: `\`${bin} --version\` 运行失败：${ver.stderr || ver.err || "unknown"}` };
  }
  return { status: "ok", path, version: firstLine(ver.stdout) ?? firstLine(ver.stderr) };
}
