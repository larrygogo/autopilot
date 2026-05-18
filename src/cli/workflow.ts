import { Command } from "commander";
import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AutopilotClient } from "../client";

export interface WorkflowCmdContext {
  getClient: (opts: { port: string }) => AutopilotClient;
  ensureDaemon: (client: AutopilotClient) => Promise<void>;
  defaultPort: number;
}

interface WorkflowItem {
  name: string;
  description?: string;
  source?: "db" | "file";
  derives_from?: string | null;
}

/**
 * 注册 autopilot workflow 子命令组。
 * （由 src/cli/index.ts 调用）
 */
export function registerWorkflowCommands(program: Command, ctx: WorkflowCmdContext): void {
  const wf = program.command("workflow").description("工作流管理");

  // ── list ──
  wf.command("list")
    .description("列出已注册工作流（含 source / derives_from）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      const list = (await client.listWorkflows()) as WorkflowItem[];
      if (list.length === 0) {
        console.log("暂无已注册工作流。");
        return;
      }
      console.log(`已注册工作流（共 ${list.length} 个）：\n`);
      const namePad = Math.max(...list.map((w) => w.name.length), 4);
      const srcPad = 6;
      console.log(
        "  " +
          "NAME".padEnd(namePad) +
          "  " +
          "SOURCE".padEnd(srcPad) +
          "  " +
          "DERIVES_FROM   DESCRIPTION"
      );
      for (const w of list) {
        const src = (w.source ?? "file").padEnd(srcPad);
        const derives = (w.derives_from ?? "-").padEnd(14);
        const desc = w.description ?? "";
        console.log("  " + w.name.padEnd(namePad) + "  " + src + "  " + derives + " " + desc);
      }
    });

  // ── show ──
  wf.command("show <name>")
    .description("查看单个工作流（yaml + 元信息）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        const meta = (await client.getWorkflow(name)) as unknown as WorkflowItem & {
          phases?: unknown[];
        };
        const yaml = (await client.getWorkflowYaml(name)) as { yaml: string };
        console.log(`# ${meta.name}`);
        console.log(`source: ${meta.source ?? "file"}`);
        if (meta.derives_from) console.log(`derives_from: ${meta.derives_from}`);
        if (meta.description) console.log(`description: ${meta.description}`);
        console.log("\n--- yaml ---\n");
        console.log(yaml.yaml);
      } catch (e: unknown) {
        console.error(`查询失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── create ──
  wf.command("create <name>")
    .description("创建 DB 工作流（必须 --derives-from 一个 file 工作流）")
    .requiredOption("--derives-from <base>", "派生自的 file 工作流名（如 req_dev）")
    .option("--from <yaml-file>", "初始 yaml 文件路径；不传则用 base 的 yaml 进 EDITOR 编辑")
    .option("-d, --description <desc>", "工作流描述", "")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: {
      derivesFrom: string;
      from?: string;
      description: string;
      port: string;
    }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);

      let yaml: string;
      if (opts.from) {
        try {
          yaml = readFileSync(opts.from, "utf8");
        } catch (e: unknown) {
          console.error(`读 ${opts.from} 失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
      } else {
        // 用 base 的 yaml 起编辑
        const baseYaml = (await client.getWorkflowYaml(opts.derivesFrom)) as { yaml: string };
        yaml = await editInTempFile(baseYaml.yaml);
      }

      try {
        const result = (await client.createWorkflow({
          name,
          description: opts.description,
          derives_from: opts.derivesFrom,
          yaml_content: yaml,
        })) as { name: string; source: string };
        console.log(`✓ 已创建 ${result.source} 工作流 ${result.name}`);
      } catch (e: unknown) {
        console.error(`创建失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── edit ──
  wf.command("edit <name>")
    .description("用 EDITOR 编辑工作流的 yaml（仅 source=db 可改）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        const cur = (await client.getWorkflowYaml(name)) as { yaml: string };
        const newYaml = await editInTempFile(cur.yaml);
        if (newYaml === cur.yaml) {
          console.log("内容未变，跳过保存。");
          return;
        }
        await client.saveWorkflowYaml(name, newYaml);
        console.log(`✓ 已保存 ${name}`);
      } catch (e: unknown) {
        console.error(`编辑失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── delete ──
  wf.command("delete <name>")
    .description("删除工作流（仅 source=db 可删）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        await client.deleteWorkflow(name);
        console.log(`✓ 已删除 ${name}`);
      } catch (e: unknown) {
        console.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── export ──
  wf.command("export <name>")
    .description("把工作流的 yaml 输出到 stdout（用于备份 / 重定向到文件）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        const yaml = await client.exportWorkflow(name);
        process.stdout.write(yaml);
      } catch (e: unknown) {
        console.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── import ──
  // ── sync ──（dogfood-bug9）
  wf.command("sync <name>")
    .description("用 repo 内 examples/workflows/<name>/ 覆盖 ~/.autopilot/workflows/<name>/ (老用户拿 dev workflow bug fix 用)")
    .option("--apply", "真正写入；不带此 flag 时只 dry-run 显示 diff")
    .action(async (name: string, opts: { apply: boolean }) => {
      const { diffWorkflowTemplate, syncWorkflowTemplate } = await import("../core/workflow-templates");
      let entries;
      try {
        entries = diffWorkflowTemplate(name);
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      const changed = entries.filter((e) => !e.identical);
      if (changed.length === 0) {
        console.log(`✓ ${name} 已是最新，无需同步`);
        return;
      }
      console.log(`本地 ~/.autopilot/workflows/${name}/ vs repo examples/workflows/${name}/ 差异：\n`);
      for (const e of changed) {
        const tag = !e.hasLocal ? "新增" : !e.hasTemplate ? "本地多" : "差异";
        const lines = e.hasLocal && e.hasTemplate
          ? `  本地 ${e.localLines} 行 / 模板 ${e.templateLines} 行`
          : e.hasLocal ? `  本地 ${e.localLines} 行` : `  模板 ${e.templateLines} 行`;
        console.log(`  [${tag}] ${e.path}\n${lines}`);
      }
      if (!opts.apply) {
        console.log(`\n(dry-run) 加 --apply 后才真正覆盖本地文件。`);
        console.log(`注意：本地文件改动会被覆盖；本地多出的文件不会被删（保留你自己加的辅助文件）。`);
        return;
      }
      try {
        const { copied } = syncWorkflowTemplate(name);
        console.log(`\n✓ 已同步 ${copied.length} 个文件到 ~/.autopilot/workflows/${name}/`);
        console.log(`  daemon 需重启才能加载新 workflow.ts：autopilot daemon restart`);
      } catch (e: unknown) {
        console.error(`同步失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  wf.command("import <name>")
    .description("从 yaml 文件创建 DB 工作流")
    .requiredOption("--derives-from <base>", "派生自的 file 工作流名")
    .requiredOption("--from <yaml-file>", "yaml 文件路径")
    .option("-d, --description <desc>", "工作流描述", "")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: {
      derivesFrom: string;
      from: string;
      description: string;
      port: string;
    }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      let yaml: string;
      try {
        yaml = readFileSync(opts.from, "utf8");
      } catch (e: unknown) {
        console.error(`读 ${opts.from} 失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      try {
        await client.createWorkflow({
          name,
          description: opts.description,
          derives_from: opts.derivesFrom,
          yaml_content: yaml,
        });
        console.log(`✓ 已导入 ${name}（派生自 ${opts.derivesFrom}）`);
      } catch (e: unknown) {
        console.error(`导入失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}

/**
 * 把内容写到临时文件，启动 $EDITOR（缺省 vim / Windows notepad），等用户保存退出后读回。
 */
async function editInTempFile(initial: string): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "autopilot-edit-"));
  const tmpFile = join(tmpDir, "workflow.yaml");
  writeFileSync(tmpFile, initial, "utf8");
  const editor =
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "vim");
  const result = spawnSync(editor, [tmpFile], { stdio: "inherit" });
  if (result.status !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`EDITOR ${editor} 退出码 ${result.status}`);
  }
  const content = readFileSync(tmpFile, "utf8");
  rmSync(tmpDir, { recursive: true, force: true });
  return content;
}
