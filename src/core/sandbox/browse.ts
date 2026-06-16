import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import { join, resolve, sep } from "path";
import { getTaskSandbox, getTaskArtifactsDir, dirSizeBytes } from "./index";

/**
 * 任务沙盒内容浏览（UI / RPC 消费）：路径安全解析 + 列目录 + 读文件预览 + 打包 + 占用统计。
 * 从 sandbox.ts 拆出的叶子模块（只依赖 sandbox 的路径解析器，无回环）。
 */

export interface SandboxEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

/** 沙盒浏览的两个根：artifacts = 阶段产物归档；workspace = 代码 clone（agent 实际改代码的工作树）。 */
export type SandboxRoot = "artifacts" | "workspace";

/**
 * 把用户传入的相对路径安全解析到 sandbox 下的绝对路径。
 * 防越界：解析后必须仍位于 sandbox 根目录下；拒绝含 NUL 字符的路径。
 * @returns 绝对路径或 null（路径非法）
 */
export function resolveSandboxPath(taskId: string, relPath: string, rootKind: SandboxRoot = "artifacts"): string | null {
  const base = rootKind === "workspace" ? getTaskSandbox(taskId) : getTaskArtifactsDir(taskId);
  const root = resolve(base);
  if (relPath.includes("\0")) return null;
  const trimmed = relPath.replace(/^[/\\]+/, "");
  const candidate = resolve(root, trimmed || ".");
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

/**
 * 列目录直接子项（单层，按名称字典序）。目录不存在时抛错。
 */
export function listSandboxDir(taskId: string, relPath: string, rootKind: SandboxRoot = "artifacts"): SandboxEntry[] {
  const abs = resolveSandboxPath(taskId, relPath, rootKind);
  if (!abs) throw new Error("非法路径");
  if (!existsSync(abs)) throw new Error("路径不存在");
  const info = statSync(abs);
  if (!info.isDirectory()) throw new Error("不是目录");

  const entries: SandboxEntry[] = [];
  for (const name of readdirSync(abs)) {
    // 代码树里隐藏 .git（巨大且无浏览价值；多库布局下各子目录层也适用；改动统计走验收 diff 视图）
    if (rootKind === "workspace" && name === ".git") continue;
    const full = join(abs, name);
    try {
      const s = statSync(full);
      if (s.isDirectory()) {
        entries.push({ name, type: "dir" });
      } else if (s.isFile()) {
        entries.push({ name, type: "file", size: s.size, mtime: s.mtimeMs });
      }
      // 跳过符号链接和特殊文件
    } catch { /* 忽略不可访问项 */ }
  }
  // 目录优先 + 名称排序
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export interface SandboxFileInfo {
  content: string;
  /** 若为二进制（非 UTF-8 可解码）则为 true，content 为空 */
  binary: boolean;
  size: number;
  truncated: boolean;
}

/** 单文件读取上限，超过只返回元信息让用户下载 */
export const MAX_PREVIEW_BYTES = 1024 * 1024; // 1 MB

/**
 * 读取文件供 UI 预览。超过上限不读内容；二进制检测失败返回空 content。
 */
export function readSandboxFile(taskId: string, relPath: string, rootKind: SandboxRoot = "artifacts"): SandboxFileInfo {
  const abs = resolveSandboxPath(taskId, relPath, rootKind);
  if (!abs) throw new Error("非法路径");
  if (!existsSync(abs)) throw new Error("文件不存在");
  const info = statSync(abs);
  if (info.isDirectory()) throw new Error("路径是目录");
  const size = info.size;
  if (size > MAX_PREVIEW_BYTES) {
    return { content: "", binary: false, size, truncated: true };
  }
  const buf = readFileSync(abs);
  // 二进制检测：含 NUL 或 UTF-8 decode 失败视为二进制
  if (buf.includes(0)) {
    return { content: "", binary: true, size, truncated: false };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { content: text, binary: false, size, truncated: false };
  } catch {
    return { content: "", binary: true, size, truncated: false };
  }
}

/**
 * 用 `zip` 命令流式压缩整个 sandbox。
 * 没装 zip 命令时抛错。调用方负责把 stdout 流包装成 Response。
 */
export function spawnSandboxZip(taskId: string): ReturnType<typeof Bun.spawn> {
  const ws = getTaskArtifactsDir(taskId);
  if (!existsSync(ws)) throw new Error("sandbox 不存在");
  return Bun.spawn(["zip", "-r", "-q", "-", "."], {
    cwd: ws,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * 计算任务 sandbox 磁盘占用（递归）。
 * 跳过不可 stat 项，静默忽略错误。
 */
export function sandboxSize(taskId: string): number {
  const ws = getTaskArtifactsDir(taskId);
  if (!existsSync(ws)) return 0;
  return dirSizeBytes(ws);
}
