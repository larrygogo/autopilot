import { Command } from "commander";
import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseWorkflowText, stringifyWorkflowDoc } from "../core/workflow/serialize";
import type { AutopilotClient } from "../client";
import {
  discover,
  listWorkflows as registryListWorkflows,
  getWorkflow as registryGetWorkflow,
  getWorkflowYaml as registryGetWorkflowYaml,
} from "../core/workflow/registry";
import { listWorkflowsInDb } from "../core/workflow/workflows";

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

/** daemon 是否可达（探测 getStatus；不可达不报错，返回 false 让调用方走离线路径）。 */
async function daemonReachable(client: AutopilotClient): Promise<boolean> {
  try {
    await client.getStatus();
    return true;
  } catch {
    return false;
  }
}

/**
 * 离线读取本地 registry——daemon 未运行时的 fallback。
 * 工作流本质是本地文件（AUTOPILOT_HOME/workflows/）+ 本地 SQLite，列出它们不该依赖 daemon。
 * 逻辑与 daemon 的 workflows.list RPC 一致（registry 内存 merge DB 的 source/derives_from）。
 */
async function listWorkflowsOffline(): Promise<WorkflowItem[]> {
  await discover();
  const inMem = registryListWorkflows();
  let dbRows: ReturnType<typeof listWorkflowsInDb> = [];
  try {
    dbRows = listWorkflowsInDb();
  } catch {
    dbRows = [];
  }
  const sourceMap = new Map(dbRows.map((r) => [r.name, r]));
  return inMem.map((wf) => {
    const row = sourceMap.get(wf.name);
    return {
      name: wf.name,
      description: wf.description,
      source: row?.source ?? "file",
      derives_from: row?.derives_from ?? null,
    };
  });
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
      // 列本地工作流不依赖 daemon：daemon 可达走 RPC，否则直接读本地 registry。
      const list = (await daemonReachable(client))
        ? ((await client.listWorkflows()) as WorkflowItem[])
        : await listWorkflowsOffline();
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
      // 查看本地工作流不依赖 daemon：daemon 可达走 RPC，否则直接读本地 registry。
      if (await daemonReachable(client)) {
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
        return;
      }

      // 离线
      await discover();
      const meta = registryGetWorkflow(name);
      if (!meta) {
        console.error(`查询失败：工作流 ${name} 不存在`);
        process.exit(1);
      }
      let source: "db" | "file" = "file";
      let derivesFrom: string | null = null;
      try {
        const row = listWorkflowsInDb().find((r) => r.name === name);
        if (row) {
          source = row.source;
          derivesFrom = row.derives_from;
        }
      } catch {
        /* DB 不可用时按 file 处理 */
      }
      const yamlStr = registryGetWorkflowYaml(name);
      console.log(`# ${meta.name}`);
      console.log(`source: ${source}`);
      if (derivesFrom) console.log(`derives_from: ${derivesFrom}`);
      if (meta.description) console.log(`description: ${meta.description}`);
      console.log("\n--- yaml ---\n");
      console.log(yamlStr ?? "(无 yaml 内容)");
    });

  // ── create ──
  wf.command("create <name>")
    .description("创建 DB 工作流（必须 --derives-from 一个 file 工作流）")
    .requiredOption("--derives-from <base>", "派生自的 file 工作流名（如 dev）")
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
        // create 编辑的是 base 的 yaml（人类友好），但用户面入库统一 JSON：转成 json 再 import
        const doc = parseWorkflowText(yaml, "yaml");
        const result = await client.importWorkflow({
          name,
          content: stringifyWorkflowDoc(doc, "json"),
          derives_from: opts.derivesFrom,
          description: opts.description,
        });
        console.log(`✓ 已创建 ${result.kind} 工作流 ${result.name}（派生自 ${opts.derivesFrom}）`);
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
    .description("把工作流导出为 JSON 到 stdout（用于备份 / 重定向到文件 / autopilot workflow import）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        const content = await client.exportWorkflow(name);
        process.stdout.write(content);
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
      const { diffWorkflowTemplate, syncWorkflowTemplate, templateRevisionStatus, reseedTemplateWorkflow } =
        await import("../core/workflow/templates");

      // native/template DB 工作流（049 迁移后 / 新装机）：无磁盘目录可覆盖，文件 sync 失效。
      // 改走 template_revision 比对 + reseed（命令名 / 体验不变，底层从「覆盖文件」变「刷新 DB 行」）。
      const status = templateRevisionStatus(name);
      if (status) {
        if (status.template <= status.local) {
          console.log(`✓ ${name} 已是最新（DB 内置模板 revision ${status.local}），无需同步`);
          return;
        }
        console.log(`${name} 是 DB 内置模板，examples 修订 ${status.template} > 本地 ${status.local}，可刷新。`);
        if (!opts.apply) {
          console.log(`\n(dry-run) 加 --apply 后用 examples 最新版覆盖该 DB 工作流。`);
          return;
        }
        const r = reseedTemplateWorkflow(name);
        if (r === "reseeded") {
          console.log(`\n✓ 已刷新 ${name} 到 revision ${status.template}`);
          console.log(`  daemon 需重启才能加载：autopilot daemon restart`);
        } else {
          console.log(`\n${name}：${r}`);
        }
        return;
      }

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
    .description("从 JSON 文件导入工作流到 DB（无 --derives-from = 独立 native；有 = 派生）")
    .requiredOption("--from <json-file>", "JSON 文件路径")
    .option("--derives-from <base>", "派生自的 file 工作流名（省略 = 独立 native 工作流）")
    .option("-d, --description <desc>", "工作流描述", "")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: {
      from: string;
      derivesFrom?: string;
      description: string;
      port: string;
    }) => {
      let content: string;
      try {
        content = readFileSync(opts.from, "utf8");
      } catch (e: unknown) {
        console.error(`读 ${opts.from} 失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        const res = await client.importWorkflow({
          name,
          content,
          derives_from: opts.derivesFrom,
          description: opts.description,
        });
        console.log(
          `✓ 已导入 ${name}（${res.kind}${opts.derivesFrom ? `，派生自 ${opts.derivesFrom}` : "，独立 DB 工作流"}）`,
        );
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
