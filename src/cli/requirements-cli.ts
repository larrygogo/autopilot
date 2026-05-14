import type { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { AutopilotClient, DEFAULT_PORT } from "../client/index";
import { readListenInfo } from "../daemon/pid";

interface ReqNewOpts {
  fromPrompt?: string;
  file?: string;
  project?: string;
  codebase?: string;
  noExtract?: boolean;
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
    .option("-c, --codebase <id>", "指定 codebase id（可空）")
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
        console.error("交互模式尚未实现，请用 --from-prompt 或 -f");
        process.exit(1);
      }
      if (!rawText.trim()) {
        console.error("错误：描述不能为空");
        process.exit(1);
      }

      // 2) 连接 daemon（raw_text 校验通过后再尝试连接，报错更精准）
      await ensureDaemon(client);

      // 3) project / codebase
      let projectId = opts.project;
      if (!projectId) {
        try {
          const { projects } = await client.listProjects();
          if (projects.length === 0) {
            console.error("错误：未找到任何 project。请先在 web /library 创建。");
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
      const codebaseId = opts.codebase;

      // 4) 抽取或兜底
      let title: string, specMd: string;
      if (opts.noExtract) {
        title = rawText.trim().slice(0, 30);
        specMd = rawText;
      } else {
        try {
          const r = await client.extractRequirement({
            raw_text: rawText,
            project_id: projectId,
            codebase_id: codebaseId ?? null,
          });
          title = r.title;
          specMd = r.spec_md;
        } catch (e: unknown) {
          console.error(`抽取失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(3);
        }
      }

      // 5) 建 requirement
      try {
        const result = await client.createRequirement({
          project_id: projectId,
          codebase_id: codebaseId ?? null,
          title,
          spec_md: specMd,
        });
        const id = result.requirement.id;
        console.log(`✓ 已创建需求 ${id} (clarifier 调查中)`);
      } catch (e: unknown) {
        console.error(`创建需求失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });
}
