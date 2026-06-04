import type { Command } from "commander";
import { existsSync } from "fs";
import { resolve } from "path";
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
        console.log("暂无 workspace。用 `autopilot workspace create <alias> <path>` 注册一个。");
        return;
      }

      const cols = ["id", "alias", "path", "default_branch", "project_id"] as const;
      const widths = cols.map((c) =>
        Math.max(c.length, ...workspaces.map((ws) => String((ws as unknown as Record<string, unknown>)[c] ?? "").length)),
      );
      // path 列截到 50
      const truncated = widths.map((w, i) => (cols[i] === "path" ? Math.min(w, 50) : w));
      console.log(cols.map((c, i) => c.padEnd(truncated[i]!)).join("  "));
      console.log(truncated.map((w) => "-".repeat(w)).join("  "));
      for (const c of workspaces) {
        const row = cols
          .map((col, i) => {
            let v = String((c as unknown as Record<string, unknown>)[col] ?? "");
            if (v.length > truncated[i]!) v = v.slice(0, truncated[i]! - 1) + "…";
            return v.padEnd(truncated[i]!);
          })
          .join("  ");
        console.log(row);
      }
      console.log(`\n共 ${workspaces.length} 个。`);
    });

  ws
    .command("create <alias> <path>")
    .description("注册本地 git 仓库为 workspace（默认分支 / GitHub 远程自动从 path 识别）")
    .option("-b, --branch <name>", "默认分支（缺省自动探测 origin/HEAD → 当前分支 → main）")
    .option("-p, --project <id>", "归属 project（默认取第一个 project；--no-project 走全局）")
    .option("--no-project", "不挂任何 project（workspace 走 project_id=null）")
    .option("--github <owner/repo>", "GitHub 仓库（可选，用于 submit_pr）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(
      async (
        alias: string,
        rawPath: string,
        opts: { branch?: string; project?: string | false; github?: string; port: string; json?: boolean },
      ) => {
        if (!alias.trim()) {
          console.error("错误：alias 不能为空");
          process.exit(2);
        }
        const abs = resolve(rawPath);
        if (!existsSync(abs)) {
          console.error(`错误：path 不存在：${abs}`);
          process.exit(2);
        }

        const client = getClient(opts.port);
        await ensureDaemon(client);

        // 解析 project_id：显式 --no-project → null，--project=<id> 用之，否则取第一个 project
        let projectId: string | undefined;
        if (opts.project === false) {
          projectId = undefined; // 不挂 project
        } else if (typeof opts.project === "string" && opts.project) {
          projectId = opts.project;
        } else {
          try {
            const { projects } = await client.listProjects();
            if (projects.length === 0) {
              console.error("错误：未找到任何 project。请先 `autopilot project create <name>`，或加 --no-project 走全局 workspace。");
              process.exit(2);
            }
            projectId = projects[0]!.id;
            console.log(`✓ 默认 project: ${projectId}`);
          } catch (e: unknown) {
            console.error(`列出 project 失败：${e instanceof Error ? e.message : String(e)}`);
            process.exit(3);
          }
        }

        const gh = parseGithub(opts.github);
        if (opts.github && !gh) {
          console.error(`错误：--github 格式应为 owner/repo，收到：${opts.github}`);
          process.exit(2);
        }

        try {
          const body: Parameters<typeof client.createWorkspace>[0] = {
            alias: alias.trim(),
            path: abs,
          };
          // 只在显式 -b 时传 branch；缺省让服务端从 git 探测
          if (opts.branch && opts.branch.trim()) body.default_branch = opts.branch.trim();
          if (projectId) body.project_id = projectId;
          if (gh) {
            body.github_owner = gh.owner;
            body.github_repo = gh.repo;
          }
          const { workspace } = await client.createWorkspace(body);
          if (opts.json) {
            console.log(JSON.stringify(workspace, null, 2));
          } else {
            const autoBranch = !opts.branch || !opts.branch.trim();
            const autoGithub = !gh && workspace.github_owner && workspace.github_repo;
            console.log(`已注册 workspace：${workspace.id}  alias=${workspace.alias}  path=${workspace.path}`);
            console.log(`  default_branch=${workspace.default_branch}${autoBranch ? "  (自动识别)" : ""}`);
            if (workspace.github_owner && workspace.github_repo) {
              console.log(`  github=${workspace.github_owner}/${workspace.github_repo}${autoGithub ? "  (自动识别)" : ""}`);
            }
            console.log(`\n下一步：autopilot req new "需求描述"   # 在 cwd 内会自动推断 workspace`);
            console.log(`     或：autopilot task start "标题" --repo ${workspace.alias} -r "需求详情" -w dev`);
          }
        } catch (e: unknown) {
          console.error(`注册失败：${e instanceof Error ? e.message : String(e)}`);
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
