import { resolve } from "node:path";
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

export function registerProjectCommands(program: Command): void {
  const proj = program.command("project").description("Project 管理（CLI 自包含创建/列出，不必依赖 web UI）");

  proj
    .command("list")
    .description("列出所有 project")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(async (opts: { port: string; json?: boolean }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      const { projects } = await client.listProjects();

      if (opts.json) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }

      if (projects.length === 0) {
        console.log("暂无 project。用 `autopilot project create <name>` 创建一个。");
        return;
      }

      const cols = ["id", "name", "description"] as const;
      const widths = cols.map((c) =>
        Math.max(c.length, ...projects.map((p) => String((p as unknown as Record<string, unknown>)[c] ?? "").length)),
      );
      const truncatedWidths = widths.map((w, i) => (cols[i] === "description" ? Math.min(w, 50) : w));
      console.log(cols.map((c, i) => c.padEnd(truncatedWidths[i]!)).join("  "));
      console.log(truncatedWidths.map((w) => "-".repeat(w)).join("  "));
      for (const p of projects) {
        const row = cols
          .map((c, i) => {
            let v = String((p as unknown as Record<string, unknown>)[c] ?? "");
            if (v.length > truncatedWidths[i]!) v = v.slice(0, truncatedWidths[i]! - 1) + "…";
            return v.padEnd(truncatedWidths[i]!);
          })
          .join("  ");
        console.log(row);
      }
      console.log(`\n共 ${projects.length} 个。`);
    });

  proj
    .command("create <name> <path>")
    .description("创建 project 并关联工作区（path 为本地代码目录，git 信息自动探测）")
    .option("--alias <alias>", "工作区别名（缺省取目录名）")
    .option("-d, --description <text>", "简短描述")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(async (name: string, rawPath: string, opts: { alias?: string; description?: string; port: string; json?: boolean }) => {
      if (!name.trim()) {
        console.error("错误：name 不能为空");
        process.exit(2);
      }
      const client = getClient(opts.port);
      await ensureDaemon(client);

      try {
        const abs = resolve(rawPath);
        const alias = opts.alias?.trim() || undefined;
        const { project, workspace } = await client.createProjectWithWorkspace({
          name: name.trim(),
          path: abs,
          alias,
          description: opts.description,
        });
        if (opts.json) {
          console.log(JSON.stringify({ project, workspace }, null, 2));
        } else {
          console.log(`已创建 project：${project.id}  ${project.name}`);
          if (project.description) console.log(`  描述：${project.description}`);
          console.log(`已关联工作区：${workspace.id}  ${workspace.alias}  ${workspace.path}`);
          console.log(`\n下一步：autopilot req new "你的需求描述" -p ${project.id}`);
        }
      } catch (e: unknown) {
        console.error(`创建失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  proj
    .command("delete <id>")
    .description("删除 project（仅当该 project 下没有 requirement / workspace）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        await client.deleteProject(id);
        console.log(`已删除 project：${id}`);
      } catch (e: unknown) {
        console.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
