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
    .description("开始/恢复需求澄清（前置：需求已选代码库）；可换澄清 agent 的 provider/model 后重试")
    .option("--provider <name>", "覆盖本需求的澄清 provider（如 kimi-code）")
    .option("--model <model>", "覆盖本需求的澄清模型（省略走 provider 默认）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string; provider?: string; model?: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        // 先设需求级澄清覆盖（换模型重试用），再进澄清
        if (opts.provider !== undefined || opts.model !== undefined) {
          await client.updateRequirement(id, {
            clarifier_provider: opts.provider ?? null,
            clarifier_model: opts.model ?? null,
          });
          console.log(`✓ 已设澄清 agent：${opts.provider ?? "(继承)"}${opts.model ? " / " + opts.model : ""}`);
        }
        const { requirement } = await client.transitionRequirement(id, "clarifying");
        console.log(
          requirement.workspace_id
            ? `✓ 需求 ${requirement.id} 已进入澄清（基于代码库 ${requirement.workspace_id}，AI 正在调查）`
            : `✓ 需求 ${requirement.id} 已进入澄清（无代码库，纯文本模式）`,
        );
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
              // 集合平铺（主库概念已废除；workspace_id 只是缓存列，集合为空时兜底展示）
              const ids = (r as { workspace_ids?: string[] }).workspace_ids ?? [];
              const all = ids.length > 0 ? ids : r.workspace_id ? [r.workspace_id] : [];
              return all.length > 0 ? all.join(" · ") : "(未关联)";
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
    .command("set-workspaces <id> [workspace-ids...]")
    .description("设置需求的代码库集合（整体替换；所有库平级、各自交付 PR；审批后冻结，failed 例外）")
    .option("--none", "清空集合（无库需求：requires.git 为 optional/false 的工作流可走纯文本闭环）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, wsIds: string[], opts: { none?: boolean; port: string }) => {
      // variadic 可选 + --none 显式空集：「忘了传」与「确认无库」必须是两个动作，防误清
      if (wsIds.length === 0 && !opts.none) {
        console.error("错误：未提供代码库 id。确认走无库请加 --none");
        process.exit(2);
      }
      if (wsIds.length > 0 && opts.none) {
        console.error("错误：--none 与代码库 id 互斥");
        process.exit(2);
      }
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement, workspace_ids } = await client.setRequirementWorkspaces(id, opts.none ? [] : wsIds);
        console.log(
          workspace_ids.length === 0
            ? `✓ 需求 ${requirement.id} 已确认无代码库（纯文本闭环）`
            : `✓ 需求 ${requirement.id} 代码库已设为 [${workspace_ids.join(", ")}]`,
        );
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("questions <id>")
    .description("列出需求的未决澄清问题（含建议选项）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { comments } = await client.listRequirementComments(id);
        const open = comments.filter((c: { kind: string; parent_id: string | null; status: string }) => c.kind === "question" && c.parent_id === null && c.status !== "resolved");
        if (open.length === 0) { console.log("（无未决问题）"); return; }
        for (const q of open) {
          console.log(`\n[${q.id}]\n${q.body}`);
          if (q.suggestions?.length) console.log(`建议选项：${q.suggestions.join(" / ")}`);
        }
        console.log(`\n回答：autopilot req answer ${id} <question-id> "<回答>"`);
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("answer <id> <question-id> <text>")
    .description("回答澄清问题（追加回复并标记已解决，AI 继续下一轮）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, questionId: string, text: string, opts: { port: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        await client.answerRequirementQuestion(id, questionId, text);
        console.log(`✓ 已回答 ${questionId}，AI 继续澄清`);
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("approve <id>")
    .description("审批通过：需求入队执行（对 spec 签字，入队后内容冻结）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement } = await client.enqueueRequirement(id);
        console.log(`✓ 需求 ${requirement.id} 已审批入队（${requirement.status}），调度器将启动执行`);
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("accept <id>")
    .description("验收通过（artifacts 交付的需求 → done；PR 交付以 GitHub merge 为准，此处拒绝）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string }) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement: r } = await client.getRequirement(id);
        if (r.status !== "awaiting_review") {
          console.error(`错误：需求当前状态 ${r.status}，仅 awaiting_review（待验收）可执行验收`);
          process.exit(2);
        }
        // 签字处唯一：有交付 PR 的需求以 GitHub merge 为验收信号（全部 PR merge 后 poller 自动 done）
        const { sub_prs } = await client.listRequirementSubPrs(id).catch(() => ({ sub_prs: [] }));
        const hasPr = (r.pr_number ?? 0) > 0 || !!r.pr_url || sub_prs.some((sp) => sp.pr_number > 0);
        if (hasPr) {
          console.error("错误：此需求交付 PR，验收以 GitHub merge 为准（签字处唯一）。");
          console.error(`请去 merge 交付 PR，全部 merge 后需求自动转 done。${r.pr_url ? `\n  主 PR：${r.pr_url}` : ""}`);
          process.exit(2);
        }
        const { requirement } = await client.transitionRequirement(id, "done");
        console.log(`✓ 需求 ${requirement.id} 验收通过，已完成`);
      } catch (e: unknown) {
        console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });

  req
    .command("reject <id>")
    .description("验收驳回：注入反馈并转 fix_revision（修复轮按反馈重做后回到待验收）")
    .requiredOption("-m, --message <reason>", "驳回理由（会喂给修复 agent）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (id: string, opts: { port: string; message: string }) => {
      const reason = opts.message.trim();
      if (!reason) {
        console.error("错误：驳回理由不能为空");
        process.exit(1);
      }
      const client = getClient(opts.port);
      await ensureDaemon(client);
      try {
        const { requirement: r } = await client.getRequirement(id);
        if (r.status !== "awaiting_review") {
          console.error(`错误：需求当前状态 ${r.status}，仅 awaiting_review（待验收）可驳回`);
          process.exit(2);
        }
        // comments.add(kind=feedback)：daemon 在 awaiting_review 自动转 fix_revision（与 Web/PR 驳回同管道）
        await client.addRequirementFeedback(id, reason);
        console.log(`✓ 需求 ${id} 已驳回，修复轮将按反馈重做（进度见 autopilot req show ${id}）`);
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
