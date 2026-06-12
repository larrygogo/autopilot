/**
 * API 模式工具集定义 + ToolExecutor。
 *
 * 安全边界（按 permission_mode 分级）：
 *   - bypassPermissions：bash 全放开，文件 API 限沙盒
 *   - default：bash 高危命令黑名单 + 敏感 env 屏蔽，文件 API 限沙盒
 *   - cautious：禁用 bash，仅文件 API（限沙盒）
 *
 * 注意：default 模式的 bash 防护是尽力而为（best-effort），不提供强沙盒保证。
 * 要获得真正的进程级隔离，应在 Docker/systemd-nspawn 等容器内运行 autopilot daemon。
 */

import { existsSync, realpathSync, lstatSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, readdirSync } from "fs";
import { join, dirname, basename, resolve, sep } from "path";
import { spawn } from "child_process";
import { log } from "../../../core/logger";

// ── 错误类型 ──

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export class UnsupportedInApiModeError extends Error {
  constructor(method: string) {
    super(
      `${method}() 在当前版本的 API 模式下不可用。` +
      "切换到 CLI 模式以使用会话功能（在 config 或 phase agent 中设置 mode: cli）。"
    );
    this.name = "UnsupportedInApiModeError";
  }
}

// ── permission_mode 类型 ──

export type PermissionMode = "bypassPermissions" | "default" | "cautious";

function normalizePermissionMode(mode?: string): PermissionMode {
  if (mode === "bypassPermissions") return "bypassPermissions";
  if (mode === "cautious") return "cautious";
  return "default";
}

// ── 路径安全 ──

/**
 * 检查路径是否在沙盒内。使用 realpath 展开符号链接 + trailing slash 防前缀劫持。
 *
 * 对不存在的路径（如 write_file 创建新文件/新子目录），向上遍历祖先目录
 * 直到找到已存在的节点，对该节点 realpath 后拼接剩余路径段。
 * 这允许 write_file("newdir/file.txt") 即使 newdir 不存在也能通过校验
 * （只要 newdir 的真实祖先在沙盒内）。
 */
export function assertInSandbox(inputPath: string, sandboxRoot: string): void {
  // trailing slash 规范化，防止 /sandbox-abc 误匹配 /sandbox-abcdef
  const normalizedRoot = sandboxRoot.endsWith(sep)
    ? sandboxRoot
    : sandboxRoot + sep;

  let resolved: string;

  if (existsSync(inputPath)) {
    // 文件/目录已存在：realpath 展开符号链接
    resolved = realpathSync(inputPath);
  } else {
    // 文件/目录不存在（如 write_file 创建新文件/新子目录）：
    // 向上遍历找到最近的已存在祖先，对其 realpath 后拼接剩余路径段
    const absPath = resolve(inputPath);
    const pendingSegments: string[] = [];
    let current = absPath;

    while (!existsSync(current)) {
      pendingSegments.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        // 到了根目录仍不存在（极端情况）
        throw new ToolError(`无法找到已存在的祖先目录：${inputPath}`);
      }
      current = parent;
    }

    const realAncestor = realpathSync(current);
    resolved = join(realAncestor, ...pendingSegments);
  }

  if (resolved !== sandboxRoot && !resolved.startsWith(normalizedRoot)) {
    throw new ToolError(`路径越界拒绝：${inputPath} → ${resolved}`);
  }
}

// ── SSRF 防护 ──

const PRIVATE_RANGES = [
  // IPv4
  /^127\./,
  /^169\.254\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^255\./,
  // IPv6
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

/** 判断字符串是否为 IPv4 地址 */
const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** 判断字符串是否为 IPv6 地址（简化版，含 ::1 等） */
const IPV6_REGEX = /^[\da-fA-F:]+$/;

function isIpAddress(hostname: string): boolean {
  return IPV4_REGEX.test(hostname) || IPV6_REGEX.test(hostname) || hostname === "localhost";
}

function checkPrivateIp(address: string, hostname: string): void {
  if (PRIVATE_RANGES.some((r) => r.test(address))) {
    throw new ToolError(
      `SSRF 防护：${hostname} 解析到私有地址 ${address}`
    );
  }
}

export async function assertSafeUrl(rawUrl: string, mode: PermissionMode): Promise<void> {
  // bypassPermissions 模式不做 SSRF 检查（对齐 CLI 现状）
  if (mode === "bypassPermissions") return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ToolError(`无效 URL：${rawUrl}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ToolError(`协议不允许：${parsed.protocol}`);
  }

  // 对 localhost 特判（URL 解析后 hostname 是 "localhost"）
  if (parsed.hostname === "localhost") {
    throw new ToolError(`SSRF 防护：localhost 解析到私有地址 127.0.0.1`);
  }

  // 如果 hostname 本身就是 IP 地址（如 127.0.0.1, ::1），直接检查，无需 DNS 解析
  if (isIpAddress(parsed.hostname)) {
    checkPrivateIp(parsed.hostname, parsed.hostname);
    return;
  }

  // 域名：DNS 解析后检查 IP
  let addresses: Array<{ address: string }>;
  try {
    const dns = await import("dns");
    addresses = await new Promise<Array<{ address: string }>>((resolve, reject) => {
      dns.resolve4(parsed.hostname, (err, addrs) => {
        if (err) {
          // 回落尝试 IPv6
          dns.resolve6(parsed.hostname, (err6, addrs6) => {
            if (err6) reject(err6);
            else resolve((addrs6 || []).map((a) => ({ address: a })));
          });
        } else {
          resolve((addrs || []).map((a) => ({ address: a })));
        }
      });
    });
  } catch {
    throw new ToolError(`DNS 解析失败：${parsed.hostname}`);
  }

  for (const { address } of addresses) {
    checkPrivateIp(address, parsed.hostname);
  }
}

// ── bash 安全 ──

// Best-effort 黑名单，已知局限：
//   - 无法拦截所有变体（如 rm -r -f /、rm --recursive --force /、alias 等）
//   - shell 拼接/变量替换可绕过（如 cmd="rm"; $cmd -rf /）
//   - 真正的进程级隔离请在容器（Docker/systemd-nspawn）内运行 daemon
const DANGEROUS_PATTERNS = [
  /rm\s+-[rf]{2}\s+\/(?!\w)/, // rm -rf / 或 rm -fr /（根目录）
  /mkfs\b/,
  /\bdd\s+if=\/dev\//,
  /:\(\)\{.*\|.*:.*&.*\};/, // fork bomb
  /wget[^|]*\|\s*(ba)?sh/,
  /curl[^|]*\|\s*(ba)?sh/,
  />\s*\/dev\/(s?da|nvme|vd)\d/, // 写裸磁盘设备
];

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

/** 敏感环境变量关键字（default 和 cautious 模式屏蔽） */
const SENSITIVE_ENV_KEYWORDS = [
  "API_KEY", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL", "PRIVATE_KEY",
  "SSH_", "AWS_", "GCP_", "ANTHROPIC_", "OPENAI_", "GOOGLE_",
];

function buildSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (SENSITIVE_ENV_KEYWORDS.some((kw) => upper.includes(kw))) continue;
    env[key] = value;
  }
  return env;
}

// ── 工具定义 ──

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** 获取指定 permission_mode 下可用的工具列表 */
export function getToolDefinitions(mode: PermissionMode): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read the contents of a file at the given path. Use offset/limit for large files.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file" },
          offset: { type: "number", description: "Line number to start reading from (0-based)" },
          limit: { type: "number", description: "Maximum number of lines to read" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a file, creating it if it doesn't exist.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "create_directory",
      description: "Create a directory (including parent directories).",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the directory" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_directory",
      description: "List files and directories in the given path.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the directory" },
        },
        required: ["path"],
      },
    },
    {
      name: "delete_file",
      description: "Delete a file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
        },
        required: ["path"],
      },
    },
    {
      name: "move_file",
      description: "Move/rename a file or directory.",
      input_schema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source path" },
          destination: { type: "string", description: "Destination path" },
        },
        required: ["source", "destination"],
      },
    },
    {
      name: "search_files",
      description: "Search for files matching a pattern using grep-like regex.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Directory to search in" },
          include: { type: "string", description: "File glob pattern to include (e.g. '*.ts')" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "fetch_url",
      description: "Fetch content from a URL (HTTP/HTTPS only).",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          method: { type: "string", description: "HTTP method (default: GET)" },
        },
        required: ["url"],
      },
    },
    {
      name: "task_complete",
      description: "Signal that all work is done. Provide a concise summary of what was accomplished.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Completion summary" },
        },
        required: ["summary"],
      },
    },
  ];

  // bash 工具仅在非 cautious 模式下可用
  if (mode !== "cautious") {
    tools.splice(tools.length - 1, 0, {
      name: "bash",
      description: "Execute a bash command. Working directory is the project sandbox.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute" },
          timeout: { type: "number", description: "Timeout in milliseconds (default: 120000)" },
        },
        required: ["command"],
      },
    });
  }

  return tools;
}

// ── ToolExecutor ──

export interface ToolCallInput {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  /** 工具名 */
  tool: string;
  /** 执行结果文本 */
  output: string;
  /** 是否出错 */
  is_error: boolean;
}

export class ToolExecutor {
  constructor(
    private sandboxRoot: string,
    private mode: PermissionMode,
  ) {}

  static fromConfig(sandboxRoot: string, permissionMode?: string): ToolExecutor {
    return new ToolExecutor(sandboxRoot, normalizePermissionMode(permissionMode));
  }

  /** 获取当前模式下可用的工具定义列表 */
  getToolDefinitions(): ToolDefinition[] {
    return getToolDefinitions(this.mode);
  }

  /** 执行单个工具调用 */
  async execute(call: ToolCallInput): Promise<ToolResult> {
    try {
      const output = await this._dispatch(call);
      return { tool: call.name, output, is_error: false };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { tool: call.name, output: `Error: ${message}`, is_error: true };
    }
  }

  private async _dispatch(call: ToolCallInput): Promise<string> {
    const { name, input } = call;
    switch (name) {
      case "read_file":
        return this._readFile(input);
      case "write_file":
        return this._writeFile(input);
      case "create_directory":
        return this._createDirectory(input);
      case "list_directory":
        return this._listDirectory(input);
      case "delete_file":
        return this._deleteFile(input);
      case "move_file":
        return this._moveFile(input);
      case "search_files":
        return this._searchFiles(input);
      case "fetch_url":
        return await this._fetchUrl(input);
      case "bash":
        return await this._bash(input);
      case "task_complete":
        // task_complete 由 loop 层处理，不应到达这里
        return input["summary"] as string || "完成";
      default:
        throw new ToolError(`未知工具：${name}`);
    }
  }

  private _resolvePath(inputPath: unknown): string {
    if (typeof inputPath !== "string" || !inputPath) {
      throw new ToolError("路径参数缺失或无效");
    }
    const resolved = resolve(this.sandboxRoot, inputPath);
    assertInSandbox(resolved, this.sandboxRoot);
    return resolved;
  }

  private _readFile(input: Record<string, unknown>): string {
    const filePath = this._resolvePath(input["path"]);
    if (!existsSync(filePath)) {
      throw new ToolError(`文件不存在：${input["path"]}`);
    }
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const offset = typeof input["offset"] === "number" ? input["offset"] : 0;
    const limit = typeof input["limit"] === "number" ? input["limit"] : lines.length;
    const sliced = lines.slice(offset, offset + limit);
    // 添加行号
    return sliced.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
  }

  private _writeFile(input: Record<string, unknown>): string {
    const filePath = this._resolvePath(input["path"]);
    const content = input["content"];
    if (typeof content !== "string") {
      throw new ToolError("content 参数缺失");
    }
    // 符号链接检查：防止通过预创建符号链接攻击
    if (existsSync(filePath)) {
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        throw new ToolError(`拒绝写入符号链接：${input["path"]}`);
      }
    }
    // 确保父目录存在
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content, "utf-8");
    return `文件已写入：${input["path"]}`;
  }

  private _createDirectory(input: Record<string, unknown>): string {
    const dirPath = this._resolvePath(input["path"]);
    mkdirSync(dirPath, { recursive: true });
    return `目录已创建：${input["path"]}`;
  }

  private _listDirectory(input: Record<string, unknown>): string {
    const dirPath = this._resolvePath(input["path"]);
    if (!existsSync(dirPath)) {
      throw new ToolError(`目录不存在：${input["path"]}`);
    }
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`)
      .join("\n");
  }

  private _deleteFile(input: Record<string, unknown>): string {
    const filePath = this._resolvePath(input["path"]);
    if (!existsSync(filePath)) {
      throw new ToolError(`文件不存在：${input["path"]}`);
    }
    unlinkSync(filePath);
    return `文件已删除：${input["path"]}`;
  }

  private _moveFile(input: Record<string, unknown>): string {
    const src = this._resolvePath(input["source"]);
    const dst = this._resolvePath(input["destination"]);
    if (!existsSync(src)) {
      throw new ToolError(`源文件不存在：${input["source"]}`);
    }
    const dstDir = dirname(dst);
    if (!existsSync(dstDir)) {
      mkdirSync(dstDir, { recursive: true });
    }
    renameSync(src, dst);
    return `已移动：${input["source"]} → ${input["destination"]}`;
  }

  private _searchFiles(input: Record<string, unknown>): string {
    const pattern = input["pattern"] as string;
    if (!pattern) throw new ToolError("pattern 参数缺失");
    const searchPath = input["path"]
      ? this._resolvePath(input["path"])
      : this.sandboxRoot;
    const includeGlob = input["include"] as string | undefined;

    // 使用 grep -rn 搜索
    const args = ["-rn", "--max-count=100"];
    if (includeGlob) args.push("--include", includeGlob);
    args.push(pattern, searchPath);

    try {
      const result = Bun.spawnSync(["grep", ...args], {
        cwd: this.sandboxRoot,
        timeout: 30_000,
      });
      const stdout = result.stdout?.toString() || "";
      if (!stdout.trim()) return "无匹配结果";
      // 截断过长的输出
      const lines = stdout.split("\n");
      if (lines.length > 200) {
        return lines.slice(0, 200).join("\n") + `\n... (省略 ${lines.length - 200} 行)`;
      }
      return stdout;
    } catch {
      return "搜索执行失败";
    }
  }

  private async _fetchUrl(input: Record<string, unknown>): Promise<string> {
    const url = input["url"] as string;
    if (!url) throw new ToolError("url 参数缺失");

    await assertSafeUrl(url, this.mode);

    const method = (input["method"] as string || "GET").toUpperCase();
    try {
      const response = await fetch(url, {
        method,
        headers: { "User-Agent": "autopilot/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      // 截断过长的响应
      if (text.length > 50_000) {
        return text.slice(0, 50_000) + "\n... (响应被截断)";
      }
      return text;
    } catch (e: unknown) {
      throw new ToolError(`fetch 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async _bash(input: Record<string, unknown>): Promise<string> {
    if (this.mode === "cautious") {
      throw new ToolError(
        "bash 工具在 cautious 模式下不可用。此模式仅允许文件 API 工具。"
      );
    }

    const command = input["command"] as string;
    if (!command) throw new ToolError("command 参数缺失");

    // default 模式：高危命令黑名单
    if (this.mode === "default" && isDangerousCommand(command)) {
      throw new ToolError(`高危命令被拒绝：${command}`);
    }

    const timeout = typeof input["timeout"] === "number" ? input["timeout"] : 120_000;

    // 构建环境变量
    const env = this.mode === "bypassPermissions"
      ? { ...process.env }
      : buildSanitizedEnv();

    return new Promise<string>((resolve, reject) => {
      const proc = spawn("bash", ["-c", command], {
        cwd: this.sandboxRoot,
        env: env as NodeJS.ProcessEnv,
        timeout,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
        // 防止输出过大导致 OOM
        if (stdout.length > 1_000_000) {
          proc.kill();
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > 500_000) {
          proc.kill();
        }
      });

      proc.on("close", (code) => {
        let output = stdout;
        if (stderr.trim()) {
          output += (output ? "\n" : "") + `[stderr] ${stderr}`;
        }
        // 截断过长输出
        if (output.length > 100_000) {
          output = output.slice(0, 100_000) + "\n... (输出被截断)";
        }
        if (code !== 0 && code !== null) {
          output += `\n[exit code: ${code}]`;
        }
        resolve(output || "(no output)");
      });

      proc.on("error", (err) => {
        reject(new ToolError(`bash 执行失败：${err.message}`));
      });
    });
  }
}
