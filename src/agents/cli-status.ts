import type { ProviderName } from "../core/config";

// ──────────────────────────────────────────────
// Provider 对应的本地 CLI 二进制检测
// Anthropic / OpenAI / Google 三家的 SDK 底层都依赖用户本地安装
// 的对应 CLI，凭证也由 CLI 管理。
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

const CLI_SPEC: Record<ProviderName, CliSpec> = {
  anthropic: {
    bin: "claude",
    install: "npm i -g @anthropic-ai/claude-code  # 然后 `claude login`",
  },
  openai: {
    bin: "codex",
    install: "npm i -g @openai/codex  # 然后 `codex login`",
  },
  google: {
    bin: "gemini",
    install: "npm i -g @google/gemini-cli  # 然后 `gemini auth login`",
  },
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

  // 1. 用 which（或 command -v）找二进制
  const which = await runShort(["which", spec.bin]);
  if (!which.ok || !which.stdout) {
    return {
      name,
      cli_installed: false,
      error: `未在 PATH 中找到 \`${spec.bin}\``,
      install_hint: spec.install,
    };
  }
  const cliPath = which.stdout;

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
