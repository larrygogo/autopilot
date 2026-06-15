import type { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { createInterface } from "node:readline";
import { AutopilotClient, DEFAULT_PORT } from "../client/index";
import { readListenInfo } from "../daemon/pid";
import type { Workspace } from "../core/workspaces";
import type { Requirement } from "../core/requirements";

// ──────────────────────────────────────────────
// 终端表格渲染工具（CJK 双宽字符感知）
// ──────────────────────────────────────────────

/**
 * 计算字符串的终端显示宽度（CJK / 全角字符占 2 列，其余占 1 列）。
 * 导出供单元测试直接验证。
 */
export function strDisplayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x2EFF) ||   // CJK Radicals Supplement
    (cp >= 0x2F00 && cp <= 0x2FDF) ||   // Kangxi Radicals
    (cp >= 0x3000 && cp <= 0x303F) ||   // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x309F) ||   // Hiragana
    (cp >= 0x30A0 && cp <= 0x30FF) ||   // Katakana
    (cp >= 0x3100 && cp <= 0x312F) ||   // Bopomofo
    (cp >= 0x3130 && cp <= 0x318F) ||   // Hangul Compatibility Jamo
    (cp >= 0x3200 && cp <= 0x33FF) ||   // Enclosed CJK / CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
    (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs（主块）
    (cp >= 0xA000 && cp <= 0xA4CF) ||   // Yi Syllables / Radicals
    (cp >= 0xA960 && cp <= 0xA97F) ||   // Hangul Jamo Extended-A
    (cp >= 0xAC00 && cp <= 0xD7FF) ||   // Hangul Syllables + Jamo Extended-B
    (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (cp >= 0xFE10 && cp <= 0xFE1F) ||   // Vertical Forms
    (cp >= 0xFE30 && cp <= 0xFE4F) ||   // CJK Compatibility Forms
    (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth Latin / Fullwidth Forms
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth Signs
    (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Extension B-F + Compat Supplement
    (cp >= 0x30000 && cp <= 0x3FFFD)    // CJK Extension G+
  );
}

/**
 * 按终端显示宽度截断字符串（CJK 感知），超出时末尾追加 ">" 作为截断标记（占 1 列）。
 * 使用 ">" 而非 "…"（U+2026），因为后者在 CJK 终端（East Asian Width = Ambiguous）
 * 可能被渲染为 2 列，导致对齐仍差 1 列。
 *
 * 边界行为：maxDispWidth < 2 时原样返回（不截断）。当前列定义中最小列宽 = 表头长度
 * （最短 "id" = 2），因此实际不会触发此分支；此处保留防御，避免未来列定义变化时溢出。
 *
 * 注：当最后一个可放入字符后剩余空间 < 下一个 CJK 字符宽度时，循环会提前 break，
 * 总宽可能比 maxDispWidth 少 1 列（保守截断）。padEndWidth 会补齐空格，不影响对齐。
 */
function truncateToWidth(s: string, maxDispWidth: number): string {
  if (maxDispWidth < 2 || strDisplayWidth(s) <= maxDispWidth) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > maxDispWidth - 1) break; // 保留 1 列给截断标记 ">"
    out += ch;
    w += cw;
  }
  return out + ">";
}

/**
 * padEnd 的终端显示宽度感知版：补空格直到目标显示宽度。
 * 若 s 已超出则原样返回（截断由 truncateToWidth 负责）。
 */
function padEndWidth(s: string, targetDispWidth: number): string {
  const current = strDisplayWidth(s);
  return current >= targetDispWidth ? s : s + " ".repeat(targetDispWidth - current);
}

// 列定义：key 约束为 keyof Requirement，拼写错误编译期即报错
const REQ_LIST_COLS: ReadonlyArray<{ key: keyof Requirement; header: string; maxWidth: number }> = [
  { key: "id",         header: "id",         maxWidth: 16 },
  { key: "title",      header: "title",      maxWidth: 40 },
  { key: "status",     header: "status",     maxWidth: 20 },
  { key: "workflow",   header: "workflow",    maxWidth: 20 },
  { key: "project_id", header: "project_id", maxWidth: 20 },
];

/** 取某列的显示值（workflow NULL 时显示默认标签）。类型安全，字段拼写编译期校验。 */
function reqCellValue(r: Requirement, key: keyof Requirement): string {
  if (key === "workflow") return r.workflow ?? "dev（默认）";
  return String(r[key] ?? "");
}

/**
 * 把 Requirement 列表渲染为对齐表格字符串（含表头 / 分隔线 / 总数行）。
 * 空列表返回友好提示字符串。导出供单元测试直接验证输出。
 */
export function renderRequirementsTable(requirements: Requirement[]): string {
  if (requirements.length === 0) {
    return "暂无需求。用 `autopilot req new \"描述\"` 创建一个。";
  }

  // 各列宽度 = min(maxWidth, max(header.length, 各行对应列的显示宽度))
  // 使用 reduce 替代 Math.max(...spread)，避免大数据量时栈溢出
  const colWidths = REQ_LIST_COLS.map(({ key, header, maxWidth }) => {
    const dataMax = requirements.reduce(
      (m, r) => Math.max(m, strDisplayWidth(reqCellValue(r, key))), 0,
    );
    return Math.min(maxWidth, Math.max(header.length, dataMax));
  });

  const lines: string[] = [];

  // 表头（统一用 padEndWidth 确保一致性，即使当前表头全为 ASCII）
  lines.push(REQ_LIST_COLS.map(({ header }, i) => padEndWidth(header, colWidths[i]!)).join("  "));
  // 分隔线（每列宽度个 -）
  lines.push(colWidths.map((w) => "-".repeat(w)).join("  "));

  for (const r of requirements) {
    const row = REQ_LIST_COLS.map(({ key }, i) => {
      // 1. 截断到列宽（CJK 感知）
      const cell = truncateToWidth(reqCellValue(r, key), colWidths[i]!);
      // 2. 补空格到列宽（CJK 感知），保证每列占相同显示宽度
      return padEndWidth(cell, colWidths[i]!);
    }).join("  ");
    lines.push(row);
  }

  lines.push(`\n共 ${requirements.length} 条。`);
  return lines.join("\n");
}

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

      // 5) 建 requirement
      try {
        const result = await client.createRequirement({
          project_id: projectId,
          workspace_id: workspaceId ?? null,
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
          ["工作区", r.workspace_id ?? "(未关联)"],
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

  req
    .command("list")
    .description("列出所有需求（默认全库；可用 --status / --project / --workspace 过滤）")
    .option("--status <status>", "按状态过滤（如 drafting / ready / done）")
    .option("--project <id>", "按 project id 过滤")
    .option("--workspace <id>", "按 workspace id 过滤")
    .option("--json", "原始 JSON 输出（机器可解析，风格与 req show --json 一致）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(
      async (opts: {
        status?: string;
        project?: string;
        workspace?: string;
        json?: boolean;
        port: string;
      }) => {
        const client = getClient(opts.port);
        try {
          // ensureDaemon 内部已 process.exit(3)，此处纳入 try/catch 纯属防御性编码——
          // 若未来 ensureDaemon 实现改为抛异常而非直接 exit，外层仍能兜住。
          await ensureDaemon(client);

          // 只传显式提供的过滤字段，不传 undefined 避免干扰 RPC handler。
          // 注：`--status ""` 等空字符串值会被 if(opts.xxx) 短路，等价于不过滤。
          // 这与 RPC handler 对空字符串的处理行为一致（typeof check 会跳过）。
          const filters: { status?: string; project_id?: string; workspace_id?: string } = {};
          if (opts.status) filters.status = opts.status;
          if (opts.project) filters.project_id = opts.project;
          if (opts.workspace) filters.workspace_id = opts.workspace;

          const { requirements } = await client.listRequirements(
            Object.keys(filters).length > 0 ? filters : undefined,
          );

          if (opts.json) {
            console.log(JSON.stringify(requirements, null, 2));
            return;
          }

          console.log(renderRequirementsTable(requirements));
        } catch (e: unknown) {
          console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
          process.exit(3);
        }
      },
    );
}
