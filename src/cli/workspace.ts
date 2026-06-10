import type { Command } from "commander";
import { AutopilotClient, DEFAULT_PORT } from "../client/index";
import { readListenInfo } from "../daemon/pid";

function getClient(port: string): AutopilotClient {
  if (port !== String(DEFAULT_PORT)) {
    return new AutopilotClient({ port: parseInt(port, 10) });
  }
  const info = readListenInfo();
  return new AutopilotClient({ port: info?.port ?? DEFAULT_PORT });
}

async function ensureDaemon(client: AutopilotClient): Promise<void> {
  try {
    await client.getStatus();
  } catch {
    console.error("错误：无法连接到 daemon。请先运行 `autopilot daemon start`。");
    process.exit(3);
  }
}

// "owner/repo" → { owner, repo }；其他形态返回 null
function parseGithub(spec: string | undefined): { owner: string; repo: string } | null {
  if (!spec) return null;
  const m = spec.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export function registerWorkspaceCommands(program: Command): void {
  const ws = program.command("workspace").description("Workspace 管理（CLI 自包含注册本地 git 仓库，不必依赖 web UI）");

  ws
    .command("list")
    .description("列出所有 workspace")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(async (opts: { port: string; json?: boolean }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      const { workspaces } = await client.listWorkspaces();

      if (opts.json) {
        console.log(JSON.stringify(workspaces, null, 2));
        return;
      }
      if (workspaces.length === 0) {
        console.log("暂无 workspace。用 `autopilot workspace create <alias> --remote <url>` 注册一个。");
        return;
      }

      const cols = ["id", "alias", "remote_url", "default_branch", "project_id"] as const;
      const widths = cols.map((c) =>
        Math.max(c.length, ...workspaces.map((ws) => String((ws as unknown as Record<string, unknown>)[c] ?? "").length)),
      );
      console.log(cols.map((c, i) => c.padEnd(widths[i]!)).join("  "));
      console.log(widths.map((w) => "-".repeat(w)).join("  "));
      for (const c of workspaces) {
        const row = cols
          .map((col, i) => {
            let v = String((c as unknown as Record<string, unknown>)[col] ?? "");
            if (v.length > widths[i]!) v = v.slice(0, widths[i]! - 1) + "…";
            return v.padEnd(widths[i]!);
          })
          .join("  ");
        console.log(row);
      }
      console.log(`\n共 ${workspaces.length} 个。`);
    });

  ws
    .command("create <alias>")
    .description("注册远程 git 仓库为 workspace（写 DB 前验证远程可达性）")
    .option("--remote <url>", "远程仓库 git URL（https://... 或 git@...）")
    .option("--github <owner/repo>", "GitHub 仓库（简写，等价于 --remote https://github.com/owner/repo.git）")
    .option("-b, --branch <name>", "默认分支（省略时自动探测远程 HEAD）")
    .option("-p, --project <id>", "归属 project（默认取第一个）")
    .option("--no-project", "不挂任何 project")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(
      async (
        alias: string,
        opts: { remote?: string; github?: string; branch?: string; project?: string | false; port: string; json?: boolean },
      ) => {
        if (!alias.trim()) {
          console.error("错误：alias 不能为空");
          process.exit(2);
        }

        // 解析 remote_url
        let remoteUrl: string | undefined;
        if (opts.remote) {
          remoteUrl = opts.remote.trim();
        } else if (opts.github) {
          const gh = parseGithub(opts.github);
          if (!gh) {
            console.error(`错误：--github 格式应为 owner/repo，收到：${opts.github}`);
            process.exit(2);
          }
          remoteUrl = `https://github.com/${gh.owner}/${gh.repo}.git`;
        }

        if (!remoteUrl) {
          console.error("错误：必须提供 --remote <url> 或 --github owner/repo");
          process.exit(2);
        }

        const client = getClient(opts.port);
        await ensureDaemon(client);

        // 解析 project_id
        let projectId: string | undefined;
        if (opts.project === false) {
          projectId = undefined;
        } else if (typeof opts.project === "string" && opts.project) {
          projectId = opts.project;
        } else {
          try {
            const { projects } = await client.listProjects();
            if (projects.length === 0) {
              console.error("错误：未找到 project。请先 `autopilot project create <name>`，或加 --no-project。");
              process.exit(2);
            }
            projectId = projects[0]!.id;
            console.log(`✓ 默认 project: ${projectId}`);
          } catch (e: unknown) {
            console.error(`列出 project 失败：${e instanceof Error ? e.message : String(e)}`);
            process.exit(3);
          }
        }

        try {
          const body: Parameters<typeof client.createWorkspace>[0] = {
            alias: alias.trim(),
            remote_url: remoteUrl,
          };
          if (opts.branch?.trim()) body.default_branch = opts.branch.trim();
          if (projectId) body.project_id = projectId;

          const { workspace } = await client.createWorkspace(body);
          if (opts.json) {
            console.log(JSON.stringify(workspace, null, 2));
          } else {
            console.log(`已注册 workspace：${workspace.id}  alias=${workspace.alias}`);
            console.log(`  remote_url=${workspace.remote_url}`);
            console.log(`  default_branch=${workspace.default_branch}${!opts.branch ? "  (自动探测)" : ""}`);
            if (workspace.github_owner && workspace.github_repo) {
              console.log(`  github=${workspace.github_owner}/${workspace.github_repo}`);
            }
            console.log(`\n下一步：autopilot req new "需求描述"`);
          }
        } catch (e: unknown) {
          console.error(`注册失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
      },
    );

  ws
    .command("update <id>")
    .description("更新 workspace（--remote 更换远程地址；-b 更换默认分支）")
    .option("--remote <url>", "新的远程仓库 URL（写入前执行 git ls-remote 验证）")
    .option("-b, --branch <name>", "更换默认分支")
    .option("--alias <name>", "重命名别名")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(
      async (
        id: string,
        opts: { remote?: string; branch?: string; alias?: string; port: string; json?: boolean },
      ) => {
        if (!opts.remote && !opts.branch && !opts.alias) {
          console.error("错误：请至少提供一个更新选项（--remote / -b / --alias）");
          process.exit(2);
        }

        const client = getClient(opts.port);
        await ensureDaemon(client);

        try {
          const body: Record<string, unknown> = {};
          if (opts.remote) body.remote_url = opts.remote.trim();
          if (opts.branch) body.default_branch = opts.branch.trim();
          if (opts.alias) body.alias = opts.alias.trim();

          const { workspace } = await client.updateWorkspace(id, body);
          if (opts.json) {
            console.log(JSON.stringify(workspace, null, 2));
          } else {
            console.log(`已更新 workspace：${id}`);
            if (workspace) {
              console.log(`  alias=${workspace.alias}  default_branch=${workspace.default_branch}`);
              if (workspace.remote_url) console.log(`  remote_url=${workspace.remote_url}`);
            }
          }
        } catch (e: unknown) {
          console.error(`更新失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
      },
    );

  ws
    .command("delete <id>")
    .description("删除 workspace（仅当没有 requirement 依赖它）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        await client.deleteWorkspace(id);
        console.log(`已删除 workspace：${id}`);
      } catch (e: unknown) {
        console.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  ws
    .command("health <id>")
    .description("跑健康检查（路径存在性、git 仓库、远端可达）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(async (id: string, opts: { port: string; json?: boolean }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const result = await client.healthcheckWorkspace(id);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        // 健康问题用 exit 1，让脚本能识别
        const r = result as unknown as { ok?: boolean; status?: string };
        if (r.ok === false || r.status === "error") process.exit(1);
      } catch (e: unknown) {
        console.error(`健康检查失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
