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

import { existsSync, realpathSync, lstatSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, readdirSync } from "fs";
import { join, dirname, basename, resolve, sep } from "path";
import { spawn } from "child_process";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { lookup as dnsLookup } from "dns/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "zlib";
import { log } from "../../../core/logger";
import { expandToApiTools } from "../../tool-capabilities";

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
  // sandboxRoot 自身也 realpath 展开，避免沙盒根是符号链接时
  // 与 realpath 后的 resolved 比较失配（误判越界或规则失效）
  let realRoot: string;
  try {
    realRoot = realpathSync(sandboxRoot);
  } catch {
    realRoot = resolve(sandboxRoot);
  }

  // trailing slash 规范化，防止 /sandbox-abc 误匹配 /sandbox-abcdef
  const normalizedRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;

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

  if (resolved !== realRoot && !resolved.startsWith(normalizedRoot)) {
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
  /^(0{1,4}:){7}0{0,3}1$/, // loopback 全展开形式 0:0:0:0:0:0:0:1
  /^::ffff:127\./i, // IPv4-mapped loopback（点分形式）
  /^::ffff:7f[0-9a-f]{2}:/i, // IPv4-mapped loopback（十六进制形式）
  /^fe80:/i,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

/** 判断字符串是否为 IPv4 地址 */
const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** 判断字符串是否为 IPv6 地址（简化版；必须含 ':'，避免把 "deadbeef" 这类纯十六进制主机名误判为 IP） */
const IPV6_REGEX = /^[\da-fA-F:.]+$/;

/** URL.hostname 对 IPv6 字面量会带方括号（如 "[::1]"），统一剥掉再判断 */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isIpAddress(hostname: string): boolean {
  const h = stripBrackets(hostname);
  return (
    IPV4_REGEX.test(h) ||
    (h.includes(":") && IPV6_REGEX.test(h)) ||
    hostname === "localhost"
  );
}

function checkPrivateIp(address: string, hostname: string): void {
  if (PRIVATE_RANGES.some((r) => r.test(address))) {
    throw new ToolError(
      `SSRF 防护：${hostname} 解析到私有地址 ${address}`
    );
  }
}

const DNS_LOOKUP_TIMEOUT_MS = 3_000;

interface ResolvedUrlTarget {
  parsed: URL;
  /** bypassPermissions 下不固定地址；其余模式始终返回已校验的目标地址。 */
  pinned?: { address: string; family: 4 | 6 };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 校验 URL 并解析出实际请求必须使用的 IP。调用者必须把 pinned 传给连接层，
 * 不能校验后再让 HTTP 客户端独立解析一次，否则会留下 DNS rebinding 窗口。
 */
async function resolveSafeUrlTarget(rawUrl: string, mode: PermissionMode): Promise<ResolvedUrlTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ToolError(`无效 URL：${rawUrl}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ToolError(`协议不允许：${parsed.protocol}`);
  }
  if (mode === "bypassPermissions") return { parsed };

  if (parsed.hostname === "localhost") {
    throw new ToolError("SSRF 防护：localhost 解析到私有地址 127.0.0.1");
  }
  if (isIpAddress(parsed.hostname)) {
    const address = stripBrackets(parsed.hostname);
    checkPrivateIp(address, parsed.hostname);
    return { parsed, pinned: { address, family: address.includes(":") ? 6 : 4 } };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await withTimeout(
      dnsLookup(parsed.hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: number }>>,
      DNS_LOOKUP_TIMEOUT_MS,
      `DNS 解析超时：${parsed.hostname}`,
    );
  } catch (e: unknown) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`DNS 解析失败：${parsed.hostname}`);
  }
  if (addresses.length === 0) throw new ToolError(`DNS 解析失败：${parsed.hostname}`);
  for (const { address } of addresses) checkPrivateIp(address, parsed.hostname);
  const selected = addresses[0];
  return { parsed, pinned: { address: selected.address, family: selected.family as 4 | 6 } };
}

export async function assertSafeUrl(rawUrl: string, mode: PermissionMode): Promise<void> {
  await resolveSafeUrlTarget(rawUrl, mode);
}

interface PinnedHttpResponse {
  status: number;
  location: string | null;
  text: string;
  truncated: boolean;
}

/** 发起固定到已校验 IP 的请求，同时保留原域名用于 Host header 与 TLS SNI。 */
function requestPinnedUrl(
  target: ResolvedUrlTarget,
  method: string,
  timeoutMs = 30_000,
): Promise<PinnedHttpResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
    const transport = target.parsed.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    const finishError = (e: unknown) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      rejectRequest(e);
    };
    const lookup = target.pinned
      ? ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options?.all) callback(null, [target.pinned]);
          else callback(null, target.pinned!.address, target.pinned!.family);
        })
      : undefined;
    const req = transport(target.parsed, {
      method,
      headers: {
        "User-Agent": "autopilot/1.0",
        // 显式声明可解压的编码：旧 fetch 实现自带透明解压，裸 http.request 没有，
        // 不声明时仍有服务器（预压缩静态资源 / 不合规实现）无条件回 gzip
        "Accept-Encoding": "gzip, deflate, br",
      },
      // Node 的重载类型不能表达同一个 callback 同时支持 all=true/false；运行时两种形态均已处理。
      lookup: lookup as never,
    }, (res) => {
      let text = "";
      let truncated = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        if (totalTimer) clearTimeout(totalTimer);
        const locationHeader = res.headers.location;
        resolveRequest({
          status: res.statusCode ?? 0,
          location: Array.isArray(locationHeader) ? (locationHeader[0] ?? null) : (locationHeader ?? null),
          text,
          truncated,
        });
      };
      // 重定向响应体无用（只读 Location），不必解压；正文按 Content-Encoding 解压后再读，
      // 否则 setEncoding("utf8") 会把压缩字节当 UTF-8 解出乱码
      const contentEncoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
      let body: NodeJS.ReadableStream = res;
      if (contentEncoding === "gzip") body = res.pipe(createGunzip());
      else if (contentEncoding === "deflate") body = res.pipe(createInflate());
      else if (contentEncoding === "br") body = res.pipe(createBrotliDecompress());
      if (body !== res) body.on("error", finishError);

      body.setEncoding("utf8");
      body.on("data", (chunk: string) => {
        const remaining = 50_000 - text.length;
        if (remaining > 0) text += chunk.slice(0, remaining);
        if (chunk.length > remaining) {
          truncated = true;
          // 已到 50KB 上限：立即带已收内容终结并断开——慢速流上继续等 'end' 会拖满总超时
          settleResolve();
          req.destroy();
        }
      });
      body.on("end", settleResolve);
      res.on("error", finishError);
    });
    // 总时长硬上限：req.setTimeout 只是 socket 空闲超时，慢速滴流响应（每几秒 1 字节）
    // 永不触发它——旧 fetch 实现的 AbortSignal.timeout 是总上限，这里补回同等语义。
    totalTimer = setTimeout(() => {
      finishError(new Error(`请求总时长超时（${timeoutMs}ms）`));
      req.destroy();
    }, timeoutMs);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on("error", finishError);
    req.end();
  });
}

/** 仅供安全回归测试：验证连接层不会对已校验主机名再次做 DNS 查询。 */
export function _requestPinnedUrlForTest(
  rawUrl: string,
  address: string,
  family: 4 | 6,
): Promise<PinnedHttpResponse> {
  return requestPinnedUrl({ parsed: new URL(rawUrl), pinned: { address, family } }, "GET", 2_000);
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

/**
 * 解析 bash 可执行路径。非 Windows 直接用 PATH 里的 bash；Windows 优先探 Git for
 * Windows 的固定安装位（Git 默认只把 cmd\ 加进 PATH，bash.exe 不在 PATH 上），
 * 再回退 Bun.which——注意 System32\bash.exe 是 WSL 入口，路径语义不同，故固定位优先。
 */
function resolveBashExecutable(): string | null {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return Bun.which("bash");
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

/**
 * 获取指定 permission_mode 下可用的工具列表。
 * allowedApiTools 给定时（来自 phase 的 tools 授权），在 permission_mode 过滤之后再取白名单交集
 * （控制通道工具 task_complete 已被 expandToApiTools 强制保留，不会被滤掉）。
 */
export function getToolDefinitions(mode: PermissionMode, allowedApiTools?: Set<string>): ToolDefinition[] {
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
      description: "Search file contents using a regular expression.",
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
      description: "Execute a shell command. Working directory is the project sandbox.",
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

  // phase 工具授权白名单（细粒度）：只保留授权集内的工具
  if (allowedApiTools) {
    return tools.filter((t) => allowedApiTools.has(t.name));
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
    /** phase 工具授权后的允许 API 工具名集合；undefined = 不限（按 permission_mode 全集） */
    private allowedTools?: Set<string>,
  ) {}

  /**
   * @param toolCaps phase 的 tools 能力白名单（如 ["read","search"]）；省略/undefined = 不限。
   *   控制通道工具由 expandToApiTools 强制保留。
   */
  static fromConfig(sandboxRoot: string, permissionMode?: string, toolCaps?: string[]): ToolExecutor {
    const allowed = toolCaps ? expandToApiTools(toolCaps) : undefined;
    return new ToolExecutor(sandboxRoot, normalizePermissionMode(permissionMode), allowed);
  }

  /** 获取当前模式 + 授权下可用的工具定义列表 */
  getToolDefinitions(): ToolDefinition[] {
    return getToolDefinitions(this.mode, this.allowedTools);
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
    // 工具授权双保险：防 LLM 幻觉调用已被 getToolDefinitions 滤掉的工具。
    // 控制通道工具（task_complete）在 allowedTools 集内，不受影响。
    if (this.allowedTools && !this.allowedTools.has(name)) {
      throw new ToolError(`工具未授权：${name}（本阶段 tools 授权未包含该能力）`);
    }
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

  private async _searchFiles(input: Record<string, unknown>): Promise<string> {
    const pattern = input["pattern"] as string;
    if (!pattern) throw new ToolError("pattern 参数缺失");
    const searchPath = input["path"]
      ? this._resolvePath(input["path"])
      : this.sandboxRoot;
    const includeGlob = input["include"] as string | undefined;
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern);
    } catch (e: unknown) {
      throw new ToolError(`无效搜索正则：${e instanceof Error ? e.message : String(e)}`);
    }
    const glob = includeGlob ? new Bun.Glob(includeGlob) : null;
    const matches: string[] = [];
    let skippedLarge = 0;
    let timedOut = false;
    const MAX_MATCHES = 200;
    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    // 执行预算：与旧 grep 子进程实现的 timeout(30s) 对齐。executor 与 daemon 同进程，
    // 无预算的全量扫描会长时间占住事件循环（HTTP/WS/watcher 全停）。
    // 已知残余局限：单次 matcher.test() 的灾难性回溯（如 (a+)+$）无法从外部打断
    //（JS 正则无超时机制），预算只保证除此以外的一切有界。
    const DEADLINE_MS = 30_000;
    const deadline = Date.now() + DEADLINE_MS;
    let sinceYield = 0;

    const searchFile = (filePath: string): void => {
      if (glob && !glob.match(basename(filePath))) return;
      let content: string;
      try {
        if (statSync(filePath).size > MAX_FILE_BYTES) { skippedLarge++; return; }
        content = readFileSync(filePath, "utf-8");
      } catch {
        return;
      }
      const relativePath = filePath.startsWith(this.sandboxRoot + sep)
        ? filePath.slice(this.sandboxRoot.length + 1)
        : filePath;
      for (const [index, line] of content.split("\n").entries()) {
        if ((index & 0xff) === 0 && Date.now() > deadline) { timedOut = true; return; }
        matcher.lastIndex = 0;
        if (!matcher.test(line)) continue;
        matches.push(`${relativePath}:${index + 1}:${line}`);
        if (matches.length >= MAX_MATCHES) return;
      }
    };
    const walk = async (entryPath: string): Promise<void> => {
      if (timedOut || matches.length >= MAX_MATCHES) return;
      if (Date.now() > deadline) { timedOut = true; return; }
      let stat;
      try { stat = lstatSync(entryPath); } catch { return; }
      if (stat.isSymbolicLink()) return;
      if (stat.isFile()) {
        searchFile(entryPath);
        return;
      }
      if (!stat.isDirectory()) return;
      let entries;
      try { entries = readdirSync(entryPath, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (timedOut || matches.length >= MAX_MATCHES) return;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        // 每处理一批条目让出一次事件循环，避免大目录扫描冻结 daemon
        if (++sinceYield >= 64) { sinceYield = 0; await Bun.sleep(0); }
        await walk(join(entryPath, entry.name));
      }
    };
    await walk(searchPath);
    const notes: string[] = [];
    if (matches.length >= MAX_MATCHES) notes.push(`已达 ${MAX_MATCHES} 条匹配上限，扫描提前结束`);
    if (skippedLarge > 0) notes.push(`跳过 ${skippedLarge} 个超过 2MB 的大文件（未搜索）`);
    if (timedOut) notes.push(`搜索超过 ${DEADLINE_MS / 1000}s 预算，未扫完全部文件`);
    const suffix = notes.length > 0 ? `\n... (${notes.join("；")})` : "";
    if (matches.length === 0) return "无匹配结果" + suffix;
    return matches.join("\n") + suffix;
  }

  private async _fetchUrl(input: Record<string, unknown>): Promise<string> {
    const url = input["url"] as string;
    if (!url) throw new ToolError("url 参数缺失");

    let method = (input["method"] as string || "GET").toUpperCase();
    let currentUrl = url;
    const MAX_REDIRECTS = 5;

    // 禁用自动重定向：每一跳的 Location 都要重新过 assertSafeUrl，
    // 防止公网 URL 302 跳到 127.0.0.1 / 169.254.169.254 等私网地址绕过 SSRF 检查
    for (let redirects = 0; ; redirects++) {
      const target = await resolveSafeUrlTarget(currentUrl, this.mode);
      let response: PinnedHttpResponse;
      try {
        response = await requestPinnedUrl(target, method);
      } catch (e: unknown) {
        throw new ToolError(`fetch 失败：${e instanceof Error ? e.message : String(e)}`);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.location;
        if (location) {
          if (redirects >= MAX_REDIRECTS) {
            throw new ToolError(`重定向次数超过上限（${MAX_REDIRECTS}）：${url}`);
          }
          try {
            currentUrl = new URL(location, currentUrl).toString();
          } catch {
            throw new ToolError(`重定向目标无效：${location}`);
          }
          // 303（及历史上 301/302 对非 GET 的事实行为）降级为 GET；307/308 保留方法。
          if (response.status === 303 || ([301, 302].includes(response.status) && method !== "GET" && method !== "HEAD")) {
            method = "GET";
          }
          continue;
        }
      }

      return response.text + (response.truncated ? "\n... (响应被截断)" : "");
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

    // Windows 也统一走 bash（Git Bash）：工具 schema 告诉模型写的是 bash 命令，
    // DANGEROUS_PATTERNS 黑名单也只认 bash 拼写。换 PowerShell 会让守卫与实际 shell
    // 脱节（Remove-Item -Recurse -Force 等破坏性命令全数放行）且模型写的 POSIX 语法
    // （&& / export / 2>/dev/null）在 Windows PowerShell 5.1 下全是解析错误。
    // 找不到 bash 时 fail-closed 报错，不降级到其它 shell。
    const bashExecutable = resolveBashExecutable();
    if (!bashExecutable) {
      throw new ToolError(
        "未找到 bash（Windows 上 bash 工具依赖 Git Bash）。请安装 Git for Windows，或把 bash 所在目录加入 PATH。"
      );
    }

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(bashExecutable, ["-c", command], {
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
