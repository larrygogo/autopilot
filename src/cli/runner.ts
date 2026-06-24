import type { Command } from "commander";
import { registerRunner } from "../daemon/runner/registration";
import { loadCredentials, clearCredentials } from "../daemon/runner/credentials";
import { isRunnerLockHeld } from "../daemon/runner/lock";
import { loadRunnerConfig, saveRunnerConfig, loadRunMode } from "../core/config";
import type { RunnerCredentials } from "../daemon/runner/types";

/** 从 stdin 读一行 token（不进 shell history；交互/管道两用）。 */
async function readTokenFromStdin(): Promise<string> {
  process.stderr.write("粘贴注册 token（输入后回车）：");
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
    if (Buffer.concat(chunks).includes(0x0a)) break; // 收到换行即止
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

/** 渲染 runner status 文本（纯函数，便于单测）。 */
export function renderRunnerStatus(creds: RunnerCredentials | null, lockHeld: boolean): string {
  if (!creds) {
    return "runner 未注册。先运行：autopilot runner register --url <reqgenie 控制平面 URL>";
  }
  const state = lockHeld ? "运行中" : "已注册（未运行 —— autopilot runner start）";
  return [
    `状态：${state}`,
    `runner_id：${creds.runner_id}`,
    `控制平面：${creds.control_plane_url}`,
  ].join("\n");
}

/** commander 可重复 option 收集器：每次 --label 触发一次，把值追加到数组。 */
export function collectLabel(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerRunnerCommands(program: Command): void {
  const runner = program.command("runner").description("reqgenie 自托管 runner 管理");

  runner
    .command("register")
    .description("用一次性注册 token 换长期凭证（token 经 stdin 输入，不进 history）")
    .requiredOption("--url <url>", "reqgenie 控制平面 URL")
    .option("--name <name>", "runner 展示名", `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "runner"}`)
    .option("--label <label>", "runner 标签（可重复，如 --label gpu --label linux）", collectLabel, [] as string[])
    .action(async (opts: { url: string; name: string; label: string[] }) => {
      try {
        const creds = await registerRunner({ url: opts.url, name: opts.name, labels: opts.label, readToken: readTokenFromStdin });
        // 把非敏感连接元数据写入 config.yaml runner 段（凭证已落 credentials.json）
        saveRunnerConfig({ ...loadRunnerConfig(), control_plane_url: creds.control_plane_url, name: opts.name });
        console.log(`注册成功：runner_id=${creds.runner_id}`);
        console.log("启动 runner：在 config.yaml 设 `mode: runner` 后 `autopilot daemon start`，或 `autopilot runner start`。");
      } catch (e: unknown) {
        console.error("注册失败：", e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });

  runner
    .command("start")
    .description("以 runner 模式前台启动 daemon（需 config.yaml 已设 mode:runner）")
    .action(async () => {
      if (!loadCredentials()) {
        console.error("尚未注册 runner。先运行 `autopilot runner register --url <reqgenie>`。");
        process.exit(1);
      }
      // runner 模式由 config.yaml.mode 决定（runner 模式与调度模式不混跑）；CLI start
      // 仅作便捷入口、不在进程内强行覆盖 loadRunMode，避免「调度模式与 runner 模式混跑」。
      if (loadRunMode() !== "runner") {
        console.error("config.yaml 未设 `mode: runner`。请先设置后再启动（runner 模式与调度模式不混跑）。");
        process.exit(1);
      }
      const { startDaemon } = await import("../daemon/index");
      await startDaemon({});
      // startDaemon resolve ≠ daemon 结束（poller/心跳定时器还在跑）；这里必须挂起，
      // 否则文件末尾 parseAsync().then() 的「短命令强制退出」兜底会把前台 runner 杀掉。
      await new Promise(() => {});
    });

  runner
    .command("status")
    .description("查看 runner 注册/运行状态")
    .action(() => {
      console.log(renderRunnerStatus(loadCredentials(), isRunnerLockHeld()));
    });

  runner
    .command("stop")
    .description("停止 runner daemon（复用 daemon stop 优雅停机）")
    .action(async () => {
      // runner daemon 与普通 daemon 共用 PID/停机机制
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(process.execPath, [process.argv[1] ?? "", "daemon", "stop"], { stdio: "inherit" });
      process.exit(r.status ?? 0);
    });

  runner
    .command("remove")
    .description("注销本机 runner 凭证（控制平面 revoke 需在 reqgenie 后台操作）")
    .action(() => {
      if (isRunnerLockHeld()) {
        console.error("runner 正在运行，先 `autopilot runner stop` 再移除凭证。");
        process.exit(1);
      }
      const removed = clearCredentials();
      saveRunnerConfig({ ...loadRunnerConfig(), control_plane_url: undefined });
      console.log(removed ? "已移除本机 runner 凭证。" : "本机无 runner 凭证。");
    });
}
