import { saveProvider, PROVIDER_NAMES, type ProviderName } from "../core/config";

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
 * 从 stdin 读取所有内容并按行分割，返回行数组（去掉末尾空行）。
 * 兼容 piped stdin（Bun.spawnSync 测试场景）和 TTY 交互输入。
 */
async function readStdinLines(): Promise<string[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.split(/\r?\n/);
}

/**
 * 交互式修复向导。处理 `init.providers` / `init.agents`。
 * 凭证类操作永远不代办，向导结束统一打印「仍需手动」清单。
 */
export async function runFixWizard(): Promise<void> {
  const isTTY = process.stdin.isTTY;

  // 非 TTY（piped）时一次性读取全部输入
  let lines: string[] | null = null;
  let lineIndex = 0;
  if (!isTTY) {
    lines = await readStdinLines();
  }

  const ask = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    if (lines !== null) {
      const line = lines[lineIndex++] ?? "";
      process.stdout.write(line + "\n");
      return line;
    }
    // TTY 模式：用 readline 单问
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => {
      rl.once("line", (ans) => { rl.close(); res(ans); });
      rl.once("close", () => res(""));
    });
  };

  const manualSteps: string[] = [];

  const allProviders = PROVIDER_NAMES.join(", ");
  const raw = (await ask(`? 启用哪些 provider？（多选用逗号分隔，可选：${allProviders}） » `)).trim();
  const chosen = raw.split(",").map((s) => s.trim()).filter(
    (s): s is ProviderName => (PROVIDER_NAMES as readonly string[]).includes(s),
  );
  if (chosen.length === 0) {
    console.log("未选任何 provider，向导退出。");
    return;
  }

  for (const name of chosen) {
    const model = (await ask(`? ${name} 默认 model（回车用 ${DEFAULT_MODELS[name]}）» `)).trim() || DEFAULT_MODELS[name];
    saveProvider(name, { enabled: true, default_model: model });
    manualSteps.push(`$ ${LOGIN_CMDS[name]}`);
  }

  // 命名复用 agent 机制已移除（Phase 3）：不再向导式创建命名 agent。
  // 每个工作流 phase 内联配置 agent、省略则走 DEFAULT_AGENT 兜底。

  console.log("\n✓ 已写入 ~/.autopilot/config.json");
  if (manualSteps.length > 0) {
    console.log("\n仍需手动：");
    for (const s of manualSteps) console.log(`  ${s}`);
  }
}
