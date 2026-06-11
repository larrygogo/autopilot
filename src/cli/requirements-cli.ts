import type { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { createInterface } from "node:readline";
import { AutopilotClient, DEFAULT_PORT } from "../client/index";
import { readListenInfo } from "../daemon/pid";
import type { Workspace } from "../core/workspaces";

/**
 * 交互式读多行描述。
 * - Pipe（非 TTY）：一次性读完整 stdin，按 line 切分
 * - TTY：readline 收集，空行结束（参考 src/cli/config-fix.ts 双模式）
 */
async function readRawTextInteractive(): Promise<string> {
  const isTTY = process.stdin.isTTY === true;
  if (!isTTY) {
    return await new Response(process.stdin as unknown as ReadableStream).text();
  }
  console.log("请描述你要做什么（多行；空行 + 回车结束）：");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const lines: string[] = [];
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (line === "" && lines.length > 0) {
        rl.close();
        return;
      }
      lines.push(line);
    });
    rl.on("close", () => resolve(lines.join("\n")));
  });
}

/** cwd 命中 workspace 时返回最长 match 的 id；否则 null。 */
export function inferWorkspaceFromCwd(workspaces: Workspace[], cwd: string = process.cwd()): string | null {
  const normalize = (p: string) => p.replace(/[\\/]+$/, "");
  const ncwd = normalize(cwd);
  const matches = workspaces.filter((c) => c.path && ncwd.startsWith(normalize(c.path)));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0]!.id;
}

interface ReqNewOpts {
  fromPrompt?: string;
  file?: string;
  project?: string;
  workspace?: string;
  /**
   * commander 把 `--no-extract` 解析为 `{ extract: false }`。
   * 之前类型写 noExtract → opts.noExtract 永远 undefined → 走默认 extract 分支
   * 跑 LLM（dogfood-bug23）。
   */
  extract?: boolean;
  port: string;
}

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

export function registerRequirementCommands(program: Command): void {
  const req = program.command("req").description("需求管理");

  req
    .command("new")
    .description("创建需求（AI 帮你整理标题+描述）")
    .option("--from-prompt <text>", "直接传一段描述，跳过交互输入")
    .option("-f, --file <path>", "从文件读取描述（Markdown）")
    .option("-p, --project <id>", "指定 project id（默认取第一个 project）")
    .option("-c, --workspace <id>", "指定 workspace id（可空）")
    .option("--no-extract", "跳过 AI 抽取，title=前 30 字、spec_md=原文")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (opts: ReqNewOpts) => {
      const client = getClient(opts.port);

      // 1) raw_text（本地参数校验，不需要 daemon）
      let rawText: string | null = null;
      if (opts.fromPrompt) {
        rawText = opts.fromPrompt;
      } else if (opts.file) {
        if (!existsSync(opts.file)) {
          console.error(`错误：文件不存在：${opts.file}`);
          process.exit(2);
        }
        rawText = readFileSync(opts.file, "utf-8");
      } else {
        rawText = await readRawTextInteractive();
      }
      if (!rawText.trim()) {
        console.error("错误：描述不能为空");
        process.exit(1);
      }

      // 2) 连接 daemon（raw_text 校验通过后再尝试连接，报错更精准）
      await ensureDaemon(client);

      // 3) project / workspace
      let projectId = opts.project;
      if (!projectId) {
        try {
          const { projects } = await client.listProjects();
          if (projects.length === 0) {
            console.error("错误：未找到任何 project。");
            console.error("请先创建一个，二选一：");
            console.error("  CLI:  autopilot project create <name>");
            console.error("  Web:  autopilot dashboard → /library");
            process.exit(2);
          }
          // 简化：用第一个 project（后续可改"最近活跃"逻辑）
          projectId = projects[0]!.id;
          console.log(`✓ 默认 project: ${projectId}`);
        } catch (e: unknown) {
          console.error(`列出 project 失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(3);
        }
      }
      let workspaceId = opts.workspace;
      if (!workspaceId && projectId) {
        try {
          const { workspaces } = await client.listWorkspaces();
          const inProject = workspaces.filter((c) => c.project_id === projectId);
          const inferred = inferWorkspaceFromCwd(inProject);
          if (inferred) {
            workspaceId = inferred;
            console.log(`✓ 默认 workspace: ${workspaceId}（从 cwd 推断）`);
          }
        } catch {
          // workspace 推断失败不阻塞流程，让 workspaceId 为 undefined
        }
      }

      // 4) 抽取或兜底
      let title: string, specMd: string;
      if (opts.extract === false) {
        // commander 把 --no-extract 解析为 { extract: false }（dogfood-bug23）
        title = rawText.trim().slice(0, 30);
        specMd = rawText;
      } else {
        try {
          const r = await client.extractRequirement({
            raw_text: rawText,
            project_id: projectId,
            workspace_id: workspaceId ?? null,
          });
          title = r.title;
          specMd = r.spec_md;
        } catch (e: unknown) {
          console.error(`抽取失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(3);
        }
      }

      // 5) 建 requirement（停在 drafting；澄清依赖代码库 clone，须先确认代码库）
      try {
        const result = await client.createRequirement({
          project_id: projectId,
          workspace_id: workspaceId ?? null,
          title,
          spec_md: specMd,
        });
        const id = result.requirement.id;
        if (workspaceId) {
          // CLI 解析出了代码库（显式 -c / cwd 推断）= 已选择 → 自动开始澄清
          await client.transitionRequirement(id, "clarifying");
          console.log(`✓ 已创建需求 ${id}（代码库 ${workspaceId}，clarifier 调查中）`);
        } else {
          console.log(`✓ 已创建需求 ${id}（草稿，已预选项目默认代码库）`);
          console.log(`  确认代码库后开始澄清：autopilot req clarify ${id}`);
          console.log(`  换代码库：autopilot req set-workspaces ${id} <ws-id...>`);
        }
      } catch (e: unknown) {
        console.error(`创建需求失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("clarify <id>")
    .description("开始/恢复需求澄清（前置：需求已选代码库）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement } = await client.transitionRequirement(id, "clarifying");
        console.log(`✓ 需求 ${requirement.id} 已进入澄清（代码库 ${requirement.workspace_id}，AI 正在调查）`);
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("show <id>")
    .description("查看需求详情（状态 / 终态原因 / 关联任务）")
    .option("--json", "原始 JSON 输出（脚本友好）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string; json?: boolean }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement: r } = await client.getRequirement(id);
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        const sourceLabel: Record<string, string> = { user: "手动", task: "任务级联", system: "系统" };
        const fields: Array<[string, unknown]> = [
          ["ID", r.id],
          ["标题", r.title],
          ["状态", r.status],
          ["项目", r.project_id],
          [
            "代码库",
            (() => {
              const ids = (r as { workspace_ids?: string[] }).workspace_ids ?? [];
              if (!r.workspace_id && ids.length === 0) return "(未关联)";
              const rest = ids.filter((w) => w !== r.workspace_id);
              return [`${r.workspace_id ?? "(无主库)"}（主）`, ...rest].join(" · ");
            })(),
          ],
          ["工作流", r.workflow ?? "dev（默认）"],
          ["关联任务", r.task_id ?? "(无)"],
          ["PR", r.pr_url ?? "(无)"],
        ];
        if (r.status_reason) {
          const src = r.status_reason_source ? sourceLabel[r.status_reason_source] ?? r.status_reason_source : "未知来源";
          fields.push([`终态原因(${src})`, r.status_reason]);
        }
        if (r.schedule_error) fields.push(["调度失败", r.schedule_error]);
        if (r.clarifier_error) fields.push(["澄清失败", r.clarifier_error]);
        const labelWidth = Math.max(...fields.map(([k]) => k.length));
        for (const [k, v] of fields) {
          console.log(`  ${k.padEnd(labelWidth)}  ${v}`);
        }
        if (r.task_id) {
          console.log("");
          console.log(`任务详情：autopilot task status ${r.task_id}`);
        }
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("set-workflow <id> <workflow>")
    .description("设置需求的执行工作流（审批后冻结；failed 可改后重试换流程）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, workflow: string, opts: { port: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement } = await client.updateRequirement(id, { workflow });
        console.log(`✓ 需求 ${requirement.id} 工作流已设为 ${workflow}`);
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("set-workspaces <id> <workspace-ids...>")
    .description("设置需求的代码库集合（整体替换；--primary 指定主库，缺省为第一个；审批后冻结，failed 例外）")
    .option("--primary <ws-id>", "主代码库（任务在此执行；必须在集合内）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, wsIds: string[], opts: { port: string; primary?: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement, workspace_ids } = await client.setRequirementWorkspaces(id, wsIds, opts.primary);
        console.log(
          `✓ 需求 ${requirement.id} 代码库已设为 [${workspace_ids.join(", ")}]，主库 ${requirement.workspace_id}`,
        );
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("set-title <id> <title>")
    .description("修改需求标题")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, title: string, opts: { port: string }) => {
      const next = title.trim();
      if (!next) {
        console.error("错误：标题不能为空");
        process.exit(1);
      }
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement } = await client.updateRequirement(id, { title: next });
        console.log(`✓ 已更新需求 ${requirement.id} 标题：${requirement.title}`);
      } catch (e: unknown) {
        console.error(`更新失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });
}
