/**
 * selfhosted CLI 命令（B-interactive 连接器管理）
 *
 * autopilot selfhosted register   — 注册实例到 reqgenie 控制面
 * autopilot selfhosted status     — 查看注册/运行状态
 * autopilot selfhosted remove     — 删除凭证（下线）
 *
 * 不删 runner CLI（additive 并存，步骤5再退役）。
 */

import type { Command } from "commander";
import { SelfhostedBackend } from "../daemon/selfhosted-connector/backend";
import { loadSelfhostedCredentials, saveSelfhostedCredentials, clearSelfhostedCredentials } from "../daemon/selfhosted-connector/credentials";
import { loadSelfhostedConfig, saveSelfhostedConfig } from "../core/config";
import type { SelfhostedCredentials } from "../daemon/selfhosted-connector/types";

/** 从 stdin 读一行 token（不进 shell history；交互/管道两用）。 */
async function readTokenFromStdin(): Promise<string> {
  process.stderr.write("粘贴注册 token（输入后回车）：");
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
    if (Buffer.concat(chunks).includes(0x0a)) break;
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

/** 渲染 selfhosted status 文本（纯函数，便于测试）。 */
export function renderSelfhostedStatus(creds: SelfhostedCredentials | null, enabled: boolean): string {
  if (!creds) {
    return "selfhosted connector 未注册。先运行：autopilot selfhosted register --url <reqgenie 控制平面 URL>";
  }
  const enabledStr = enabled ? "已启用（config.selfhosted.enabled=true）" : "已注册但未启用（需在 config.json 设 selfhosted.enabled: true）";
  return [
    `状态：${enabledStr}`,
    `instance_id：${creds.instance_id}`,
    `控制平面：${creds.control_plane_url}`,
  ].join("\n");
}

export function registerSelfhostedCommands(program: Command): void {
  const selfhosted = program
    .command("selfhosted")
    .description("reqgenie B-interactive 自托管连接器管理");

  selfhosted
    .command("register")
    .description("用一次性注册 token 换长期凭证，并在 config.json 开启 connector（token 经 stdin 输入，不进 history）")
    .requiredOption("--url <url>", "reqgenie 控制平面 URL")
    .option("--name <name>", "实例展示名", `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "autopilot-instance"}`)
    .action(async (opts: { url: string; name: string }) => {
      if (loadSelfhostedCredentials()) {
        console.error(
          "本机已注册 selfhosted 实例；先运行 `autopilot selfhosted remove` 再重新注册。",
        );
        process.exit(1);
      }

      let token: string;
      try {
        token = (await readTokenFromStdin()).trim();
      } catch (e: unknown) {
        console.error("读取 token 失败：", e instanceof Error ? e.message : String(e));
        process.exit(1);
      }

      if (!token) {
        console.error("注册 token 为空。");
        process.exit(1);
      }

      try {
        const { instance_id, secret } = await SelfhostedBackend.register(
          opts.url,
          token,
          opts.name,
        );

        const creds: SelfhostedCredentials = {
          control_plane_url: opts.url.replace(/\/+$/, ""),
          instance_id,
          secret,
        };
        saveSelfhostedCredentials(creds);

        // 把连接元数据写 config.json selfhosted 段 + 自动启用
        saveSelfhostedConfig({
          ...loadSelfhostedConfig(),
          control_plane_url: creds.control_plane_url,
          enabled: true,
        });

        console.log(`注册成功：instance_id=${instance_id}`);
        console.log("下次启动 daemon 时 selfhosted connector 将自动连接 reqgenie 控制面。");
        console.log("（无需改 config.json mode，标准 daemon 模式 + connector 并存）");
      } catch (e: unknown) {
        console.error("注册失败：", e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });

  selfhosted
    .command("status")
    .description("查看 selfhosted connector 注册/启用状态")
    .action(() => {
      const creds = loadSelfhostedCredentials();
      const cfg = loadSelfhostedConfig();
      console.log(renderSelfhostedStatus(creds, cfg.enabled ?? false));
    });

  selfhosted
    .command("remove")
    .description("删除本机 selfhosted 凭证（下线实例）")
    .action(() => {
      const removed = clearSelfhostedCredentials();
      if (removed) {
        // 同步关闭 config.json 中的 enabled 开关，防止下次 daemon 启动报无凭证
        saveSelfhostedConfig({ ...loadSelfhostedConfig(), enabled: false });
        console.log("selfhosted 凭证已删除，connector 已禁用。");
      } else {
        console.log("本机未注册 selfhosted 实例。");
      }
    });
}
